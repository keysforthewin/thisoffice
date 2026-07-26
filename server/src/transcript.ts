import path from 'node:path';
import type { Office } from './office.ts';
import type { ScreenStreamer } from './streamer.ts';
import type { StatsAggregator } from './stats.ts';
import { MONITOR_IMAGE_MARKER, type Employee } from '../../shared/types.ts';

/**
 * Turns raw Claude Code transcript JSONL lines into office activity.
 *
 * Files look like:
 *   ~/.claude/projects/<proj-dir>/<sessionId>.jsonl                    main session
 *   ~/.claude/projects/<proj-dir>/<sessionId>/subagents/agent-*.jsonl  subagent transcripts
 */

interface Activity {
  key: string; // sessionId:toolUseId (or sessionId:<uuid> for boss replies)
  employeeId: string | null;
  tool: string;
  isTask: boolean;
  sessionId: string;
  project: string;
  agentFile?: string;
  /** set while waiting in the office work queue */
  pendingTitle?: string;
  buffer?: string[];
  doneWhileQueued?: boolean;
  /** Task activities only: toolUseIds of tools fanned out from its subagent transcript */
  children?: Set<string>;
  /** fanned-out child activities only: the Task activity that spawned them */
  parentTask?: Activity;
}

/**
 * Subagent tools that stay as one-line breadcrumbs on the Task's own screen instead of
 * fanning out to their own employee: nested Task/Agent would poison the FIFO subagent-file
 * matching (keyed by parent sessionId), and the whiteboard tools must not mutate the board
 * from subagent context.
 */
const FANOUT_EXCLUDED = new Set(['Task', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput']);

interface TrackedTask {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const BOSS_IDLE_MS = 8000;
const MAX_BUFFERED_LINES = 500;
/** Ephemeral session-event screens cap their body so a claim never dwells forever. */
const EPHEMERAL_MAX_LINES = 40;
/** Housekeeping one-liners batch per file until this much quiet, then flush as one screen. */
const DIGEST_QUIET_MS = 3000;
const DIGEST_MAX_LINES = 20;

/**
 * Terminal stop_reasons: the response ended without queuing tool work, so the
 * session is sitting at the prompt waiting for the user. ('tool_use' means work
 * is pending; streamed partial lines carry a null stop_reason.)
 */
const WAITING_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
/**
 * Backstop only: user-activity eviction handles resumes/forks in the same
 * project dir; this catches files eviction can't see (deleted transcripts,
 * renamed project dirs, missed watcher events).
 */
const SESSION_STALE_MS = 10 * 60_000;
const STALE_SWEEP_MS = 60_000;

export class Transcripts {
  /** toolUseId -> activity (toolUseIds are globally unique) */
  private activities = new Map<string, Activity>();
  /** sessionId -> Task activities awaiting a subagent file */
  private pendingTasks = new Map<string, Activity[]>();
  /** agent transcript file -> activity */
  private agentFiles = new Map<string, Activity>();
  /** sessionId -> subagent files that appeared before their Task tool_use */
  private unmatchedAgentFiles = new Map<string, string[]>();
  /** file -> parsed lines held until the file is matched to an activity */
  private bufferedLines = new Map<string, any[]>();
  /** agent transcript files whose activity already finished; further lines are dropped */
  private finishedAgentFiles = new Set<string>();
  private bossIdleTimer: NodeJS.Timeout | null = null;
  /** task-list tracking (TaskCreate/TaskUpdate tools), per project */
  private tasks = new Map<string, Map<string, TrackedTask>>();
  /** toolUseId -> TaskCreate subject awaiting its assigned id in the result */
  private pendingTaskCreates = new Map<string, { project: string; subject: string }>();
  /** toolUseId -> TaskUpdate input awaiting confirmation */
  private pendingTaskUpdates = new Map<string, { project: string; taskId: string; status?: string; subject?: string }>();
  private replySeq = 0;
  private ephemeralSeq = 0;
  /** sessionId -> ai-title, appended to ephemeral screen titles once known */
  private sessionTitles = new Map<string, string>();
  /** main transcript file -> pending housekeeping digest */
  private digests = new Map<string, { sessionId: string; project: string; lines: string[]; timer: NodeJS.Timeout }>();
  /** activity key -> queued activity awaiting an employee */
  private queued = new Map<string, Activity>();
  /**
   * main transcript file -> waiting-for-input state. A resumed session's new
   * file gets its own entry; user activity in any file evicts sibling entries
   * in the same project dir (see clearSiblingSessions).
   */
  private sessions = new Map<string, { waiting: boolean; lastEventAt: number }>();

  constructor(
    private office: Office,
    private streamer: ScreenStreamer,
    private stats?: StatsAggregator,
  ) {
    office.onAssign((key, employee) => this.onQueuedAssigned(key, employee));
    setInterval(() => this.recomputeWaiting(), STALE_SWEEP_MS).unref?.();
  }

  private setSessionWaiting(file: string, waiting: boolean) {
    this.sessions.set(file, { waiting, lastEventAt: Date.now() });
    this.recomputeWaiting();
  }

  /**
   * User input in one file proves the boss is active in this project; any
   * sibling file still flagged waiting is a pre-resume/-fork/-compact husk.
   */
  private clearSiblingSessions(file: string) {
    const dir = path.dirname(file);
    for (const other of this.sessions.keys()) {
      if (other !== file && path.dirname(other) === dir) this.sessions.delete(other);
    }
  }

  private recomputeWaiting() {
    const now = Date.now();
    for (const [file, s] of this.sessions) {
      if (now - s.lastEventAt > SESSION_STALE_MS) this.sessions.delete(file);
    }
    let waiting = false;
    for (const s of this.sessions.values()) waiting ||= s.waiting;
    // Office dedupes, so calling on every recompute doesn't spam broadcasts
    this.office.setWaitingForInput(waiting);
  }

  private emitTo(activity: Activity, text: string) {
    if (activity.employeeId) this.streamer.enqueue(activity.employeeId, text);
    else activity.buffer?.push(text);
  }

  private onQueuedAssigned(key: string, employee: Employee) {
    const activity = this.queued.get(key);
    if (!activity) {
      // Unknown key (e.g. duplicate pickup after the first already released it):
      // the employee is already marked working for this key in Office; release
      // the desk instead of leaving it stranded forever.
      this.office.finish(key);
      return;
    }
    this.queued.delete(key);
    activity.employeeId = employee.id;
    this.office.monitor(employee.id, { clear: true, title: activity.pendingTitle ?? '' });
    if (activity.buffer?.length) this.streamer.enqueue(employee.id, activity.buffer.join('\n'));
    activity.buffer = undefined;
    if (activity.doneWhileQueued) this.office.finish(key);
  }

  private projectLabel(sessionId: string, project: string): string {
    const title = this.sessionTitles.get(sessionId);
    if (!title) return project;
    const t = title.length > 40 ? title.slice(0, 37) + '…' : title;
    return `${project} — ${t}`;
  }

  /**
   * Claim a free monitor, stream `text`, and finish immediately (queue with
   * doneWhileQueued when the office is full) — the pattern boss replies use,
   * generalized for any session-level event.
   */
  private showEphemeral(sessionId: string, project: string, title: string, text: string, opts?: { key?: string }) {
    const body = capLines(text, EPHEMERAL_MAX_LINES);
    if (!body.trim()) return;
    const key = opts?.key ?? `${sessionId}:eph-${++this.ephemeralSeq}`;
    const fullTitle = `${title} · ${this.projectLabel(sessionId, project)}`;
    const { employee, hired } = this.office.assign(key, title);
    if (!employee) {
      this.queued.set(key, {
        key,
        employeeId: null,
        tool: 'ephemeral',
        isTask: false,
        sessionId,
        project,
        pendingTitle: fullTitle,
        buffer: [body],
        doneWhileQueued: true,
      });
      return;
    }
    // only name genuinely new hires; a rehire into a remembered seat keeps their name
    if (hired && employee.name === 'New Hire') {
      const name = this.office.pickHireName();
      this.office.rename(employee.id, name);
      this.office.pushStatus('hire', `New hire: ${name} joined the office`);
    }
    this.office.monitor(employee.id, { clear: true, title: fullTitle });
    this.streamer.enqueue(employee.id, body);
    this.office.finish(key);
  }

  /** Append a housekeeping one-liner; flushes as one "Office Chores" screen after a quiet gap. */
  private digest(file: string, sessionId: string, project: string, note: string) {
    let d = this.digests.get(file);
    if (d) {
      clearTimeout(d.timer);
    } else {
      d = { sessionId, project, lines: [], timer: undefined as unknown as NodeJS.Timeout };
      this.digests.set(file, d);
    }
    d.lines.push(note);
    if (d.lines.length >= DIGEST_MAX_LINES) {
      this.flushDigest(file);
      return;
    }
    d.timer = setTimeout(() => this.flushDigest(file), DIGEST_QUIET_MS);
    d.timer.unref?.();
  }

  private flushDigest(file: string) {
    const d = this.digests.get(file);
    if (!d) return;
    clearTimeout(d.timer);
    this.digests.delete(file);
    this.showEphemeral(d.sessionId, d.project, 'Office Chores', d.lines.join('\n'));
  }

  fileAppeared(file: string) {
    if (!isSubagentFile(file)) return;
    const sessionId = sessionIdForSubagentFile(file);
    const activity = this.pendingTasks.get(sessionId)?.shift();
    if (activity) {
      this.attachAgentFile(activity, file);
      return;
    }
    // Task tool_use hasn't been read yet (event-order race): pool the file.
    const pool = this.unmatchedAgentFiles.get(sessionId) ?? [];
    pool.push(file);
    this.unmatchedAgentFiles.set(sessionId, pool);
  }

  private attachAgentFile(activity: Activity, file: string) {
    activity.agentFile = file;
    this.agentFiles.set(file, activity);
    const buffered = this.bufferedLines.get(file);
    if (buffered) {
      this.bufferedLines.delete(file);
      for (const l of buffered) this.handleSubagentLine(activity, l);
    }
  }

  handleLines(file: string, lines: string[]) {
    const agentActivity = this.agentFiles.get(file);
    for (const raw of lines) {
      let line: any;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (agentActivity || isSubagentFile(file)) {
        if (agentActivity) {
          this.handleSubagentLine(agentActivity, line);
        } else if (!this.finishedAgentFiles.has(file)) {
          const buf = this.bufferedLines.get(file) ?? [];
          if (buf.length < MAX_BUFFERED_LINES) buf.push(line);
          this.bufferedLines.set(file, buf);
        }
        continue;
      }
      this.handleMainLine(file, line);
    }
  }

  private touchBoss() {
    this.office.setBossStatus('working');
    if (this.bossIdleTimer) clearTimeout(this.bossIdleTimer);
    this.bossIdleTimer = setTimeout(() => this.office.setBossStatus('idle'), BOSS_IDLE_MS);
  }

  private handleMainLine(file: string, line: any) {
    if (line.isSidechain) return; // legacy embedded subagent traffic
    const sessionId: string = line.sessionId ?? path.basename(file, '.jsonl');
    const project = projectName(line.cwd, file);
    if (sessionId) this.stats?.recordSession(sessionId);

    // Sidecar record types carry no envelope (no uuid/cwd/message); the handlers
    // below must never assume one. One malformed line must not kill its batch-mates.
    try {
      switch (line.type) {
        case 'user':
          this.handleUserLine(file, sessionId, project, line);
          break;
        case 'assistant':
          this.handleAssistantLine(file, sessionId, project, line);
          break;
        case 'system':
          this.handleSystemLine(file, sessionId, project, line);
          break;
        case 'attachment':
          this.handleAttachmentLine(file, sessionId, project, line);
          break;
        default:
          this.handleSidecarLine(file, sessionId, project, line);
      }
    } catch {
      /* defensive: unknown/legacy shapes render as nothing rather than crash the tail */
    }
  }

  private handleUserLine(file: string, sessionId: string, project: string, line: any) {
    // Any user-role line exists because input reached the model (prompt, tool
    // result, slash command, interrupt, injected notification…) — the session
    // is no longer waiting, and neither is any pre-resume/-fork/-compact
    // sibling file in the same project dir.
    this.clearSiblingSessions(file);
    this.setSessionWaiting(file, false);
    const content = line.message?.content;
    const blocks = contentBlocks(content);
    // tool results come back as user-role messages
    const results = blocks.filter((b) => b.type === 'tool_result');
    const images = extractImages(content);
    const text = extractText(content);

    if (results.length > 0) {
      for (const r of results) {
        this.finishTool(r, { toolUseResult: line.toolUseResult, toolDenialKind: line.toolDenialKind });
      }
      this.touchBoss();
      // text sharing the line with results is the Boss typing mid-turn
      if (text) this.routeUserText(file, sessionId, project, line, text, true);
      return;
    }

    if (images.length > 0) {
      const imgLines = images.map((img) => MONITOR_IMAGE_MARKER + img);
      this.showEphemeral(sessionId, project, 'Attachment from the Boss', [...imgLines, text].filter(Boolean).join('\n'));
    }
    if (text) this.routeUserText(file, sessionId, project, line, text, false);
  }

  /** Route a user text blob: interrupts, tagged command/hook traffic, meta noise, or a real prompt. */
  private routeUserText(file: string, sessionId: string, project: string, line: any, text: string, alongsideResults: boolean) {
    if (text.startsWith('[Request interrupted')) {
      this.showEphemeral(sessionId, project, 'Interrupted', '✗ the Boss interrupted');
      return;
    }
    if (text.startsWith('<')) {
      this.routeTaggedText(file, sessionId, project, text);
      return;
    }
    if (line.isMeta) {
      this.digest(file, sessionId, project, firstLine(text, 60));
      return;
    }
    if (alongsideResults) {
      this.showEphemeral(sessionId, project, 'Note from the Boss', text);
      return;
    }
    this.touchBoss();
    this.onUserPrompt(project, text, line.uuid);
  }

  /** User text starting with '<': slash commands, ! shell passthrough, notifications, reminders. */
  private routeTaggedText(file: string, sessionId: string, project: string, text: string) {
    const commandName = tagContent(text, 'command-name');
    if (commandName !== undefined) {
      const args = tagContent(text, 'command-args');
      const msg = tagContent(text, 'command-message');
      const lines = [`ran ${commandName}${args ? ' ' + args : ''}`];
      if (msg) lines.push(msg);
      this.showEphemeral(sessionId, project, 'Slash Command', lines.join('\n'));
      return;
    }
    const stdout = tagContent(text, 'local-command-stdout');
    if (stdout !== undefined) {
      this.showEphemeral(sessionId, project, 'Command Output', stdout || '(no output)');
      return;
    }
    const bashIn = tagContent(text, 'bash-input');
    const bashOut = tagContent(text, 'bash-stdout');
    const bashErr = tagContent(text, 'bash-stderr');
    if (bashIn !== undefined || bashOut !== undefined || bashErr !== undefined) {
      const parts: string[] = [];
      if (bashIn) parts.push(`! ${bashIn}`);
      if (bashOut) parts.push(bashOut);
      if (bashErr) parts.push(bashErr.split('\n').map((l) => '✗ ' + l).join('\n'));
      this.showEphemeral(sessionId, project, 'Shell (!)', parts.join('\n'));
      return;
    }
    const notif = tagContent(text, 'task-notification');
    if (notif !== undefined) {
      const summary = tagContent(notif, 'summary');
      const result = tagContent(notif, 'result');
      this.showEphemeral(sessionId, project, 'Task Notification', [summary, result].filter(Boolean).join('\n') || notif);
      return;
    }
    const tag = text.match(/^<([a-zA-Z0-9_-]+)/)?.[1] ?? 'tagged';
    if (tag === 'system-reminder') {
      const inner = tagContent(text, 'system-reminder') ?? text;
      this.digest(file, sessionId, project, 'reminder: ' + firstLine(inner, 60));
      return;
    }
    this.digest(file, sessionId, project, `${tag}: ${firstLine(stripTags(text), 60)}`);
  }

  private handleAssistantLine(file: string, sessionId: string, project: string, line: any) {
    if (line.isApiErrorMessage || line.error) {
      const status = line.apiErrorStatus ? ` ${line.apiErrorStatus}` : '';
      const text = extractText(line.message?.content);
      const detail = typeof line.errorDetails === 'string' ? firstLine(line.errorDetails, 120) : '';
      this.showEphemeral(
        sessionId,
        project,
        'API Trouble',
        [`✗ ${line.error ?? 'api error'}${status}`, text, detail].filter(Boolean).join('\n'),
      );
      return;
    }
    if (line.message?.usage) this.stats?.recordUsage(line.message?.id ?? line.requestId, line.message?.model, line.message.usage);
    const blocks = contentBlocks(line.message?.content);
    for (const b of blocks) {
      if (b.type === 'fallback') {
        this.showEphemeral(sessionId, project, 'Model Swap', `⚠ model fallback: ${b.from?.model ?? '?'} → ${b.to?.model ?? '?'}`);
      }
      if (b.type === 'tool_use') this.stats?.recordTool(b.name, b.id);
    }
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    // every content block of one response repeats the response's stop_reason,
    // so this just re-sets the same boolean — no dedupe needed
    this.setSessionWaiting(file, WAITING_STOP_REASONS.has(line.message?.stop_reason));
    if (toolUses.length > 0) this.touchBoss();
    for (const tu of toolUses) this.startTool(sessionId, project, tu);
    this.onBossReply(sessionId, project, line, blocks);
  }

  private handleSystemLine(file: string, sessionId: string, project: string, line: any) {
    const content = String(line.content ?? '');
    switch (line.subtype) {
      case 'away_summary':
        this.showEphemeral(sessionId, project, 'While You Were Away', content);
        this.office.pushStatus('away', `While you were away: ${firstLine(content, 90)}`);
        break;
      case 'scheduled_task_fire':
        this.showEphemeral(sessionId, project, 'Scheduled Task', content);
        break;
      case 'local_command':
        this.showEphemeral(sessionId, project, 'Command Output', tagContent(content, 'local-command-stdout') ?? content);
        break;
      case 'model_refusal_fallback':
        this.showEphemeral(
          sessionId,
          project,
          'Model Swap',
          `⚠ ${line.originalModel ?? '?'} refused (${line.apiRefusalCategory ?? 'unknown'}) → ${line.fallbackModel ?? '?'}`,
        );
        break;
      case 'stop_hook_summary': {
        if (line.preventedContinuation) {
          this.showEphemeral(sessionId, project, 'Hook Blocked Stop', `✗ stop hook prevented continuation: ${line.stopReason ?? ''}`.trim());
        } else {
          const ms = (line.hookInfos ?? []).reduce((s: number, h: any) => s + (h.durationMs ?? 0), 0);
          this.digest(file, sessionId, project, `hooks: ${line.hookCount ?? line.hookInfos?.length ?? 0} ran (${ms}ms)`);
        }
        break;
      }
      case 'turn_duration':
        this.stats?.recordTurn(line.durationMs, line.uuid);
        this.digest(file, sessionId, project, `turn: ${Math.round((line.durationMs ?? 0) / 1000)}s, ${line.messageCount ?? 0} msgs`);
        break;
      case 'bridge_status':
        this.digest(file, sessionId, project, `bridge: ${firstLine(content, 60)}`);
        break;
      default:
        this.digest(file, sessionId, project, `system: ${line.subtype ?? '?'}${content ? ' — ' + firstLine(content, 60) : ''}`);
    }
  }

  private handleAttachmentLine(file: string, sessionId: string, project: string, line: any) {
    const att = line.attachment ?? {};
    switch (att.type) {
      case 'hook_success': {
        const err = att.stderr ? String(att.stderr).split('\n').map((l: string) => '✗ ' + l).join('\n') : '';
        const out = [att.stdout, err].filter((s) => s && String(s).trim()).join('\n');
        if (out.trim()) {
          this.showEphemeral(sessionId, project, `Hook: ${att.hookName ?? 'hook'}`, `$ ${att.command ?? ''}\n${out}`);
        } else {
          this.digest(file, sessionId, project, `hook ${att.hookName ?? '?'} ok (${att.durationMs ?? 0}ms)`);
        }
        break;
      }
      case 'hook_additional_context':
        this.showEphemeral(sessionId, project, 'Hook Context', flattenContent(att.content));
        break;
      case 'queued_command':
        this.showEphemeral(sessionId, project, 'Queued Prompt', String(att.prompt ?? ''));
        break;
      case 'edited_text_file':
        this.showEphemeral(sessionId, project, 'Edited in IDE', [att.filename, att.snippet].filter(Boolean).join('\n'));
        break;
      case 'plan_mode_exit':
        this.showEphemeral(sessionId, project, 'Plan Approved', `plan accepted: ${att.planFilePath ?? ''}`);
        this.office.pushStatus('plan', `Plan approved · ${project}`);
        break;
      case 'plan_mode':
      case 'plan_mode_reentry':
        this.digest(file, sessionId, project, `plan mode${att.reminderType ? ` (${att.reminderType})` : ''}`);
        break;
      case 'task_reminder':
        // full todo list already lives on the whiteboard; just note the nudge
        this.digest(file, sessionId, project, `todo reminder (${att.itemCount ?? '?'} items)`);
        break;
      case 'skill_listing':
        this.digest(file, sessionId, project, `skills: ${att.skillCount ?? att.names?.length ?? '?'} available`);
        break;
      case 'command_permissions':
        this.digest(file, sessionId, project, `permissions: ${att.allowedTools?.length ?? 0} tools allowed`);
        break;
      case 'deferred_tools_delta':
        this.digest(file, sessionId, project, `deferred tools: +${att.addedNames?.length ?? 0}/-${att.removedNames?.length ?? 0}`);
        break;
      case 'mcp_instructions_delta':
        this.digest(file, sessionId, project, `mcp instructions: +${att.addedNames?.length ?? 0}`);
        break;
      case 'agent_listing_delta':
        this.digest(file, sessionId, project, `agents: +${att.addedTypes?.length ?? 0}`);
        break;
      case 'dynamic_skill':
        this.digest(file, sessionId, project, `skill loaded: ${(att.skillNames ?? []).join(', ')}`);
        break;
      case 'nested_memory':
        this.digest(file, sessionId, project, `memory: ${att.displayPath ?? att.path ?? ''}`);
        break;
      case 'read_truncation_notice':
        this.digest(file, sessionId, project, firstLine(String(att.banner ?? 'read truncated'), 60));
        break;
      case 'date_change':
        this.digest(file, sessionId, project, `date → ${att.newDate ?? ''}`);
        break;
      case 'opened_file_in_ide':
        this.digest(file, sessionId, project, `opened ${att.filename ?? ''}`);
        break;
      default:
        this.digest(file, sessionId, project, `attachment: ${att.type ?? '?'}`);
    }
  }

  /** Envelope-less state records ({type:'ai-title',...} etc.) and legacy/unknown types. */
  private handleSidecarLine(file: string, sessionId: string, project: string, line: any) {
    switch (line.type) {
      case 'ai-title':
        if (line.aiTitle) {
          this.showEphemeral(sessionId, project, 'Session Titled', `“${line.aiTitle}”`);
          this.sessionTitles.set(sessionId, String(line.aiTitle));
          this.office.pushStatus('session', `Looking at ${project}: “${line.aiTitle}”`);
        }
        break;
      case 'agent-name':
        if (line.agentName) this.showEphemeral(sessionId, project, 'Agent Named', `“${line.agentName}”`);
        break;
      case 'permission-mode':
        this.digest(file, sessionId, project, `mode → ${line.permissionMode ?? '?'}`);
        break;
      case 'mode':
        this.digest(file, sessionId, project, `mode → ${line.mode ?? '?'}`);
        break;
      case 'queue-operation':
        if (line.operation === 'enqueue' && line.content) {
          this.showEphemeral(sessionId, project, 'Queued Prompt', String(line.content));
        } else {
          this.digest(file, sessionId, project, `queue: ${line.operation ?? '?'}`);
        }
        break;
      case 'relocated':
        this.digest(file, sessionId, project, `relocated → ${path.basename(String(line.relocatedCwd ?? ''))}`);
        break;
      case 'worktree-state':
        this.digest(file, sessionId, project, `worktree: ${line.worktreeSession?.worktreeName ?? ''}`);
        break;
      case 'bridge-session':
        this.digest(file, sessionId, project, 'bridge session linked');
        break;
      default:
        // legacy (summary/progress/compact_boundary), file-history-*, last-prompt, future types
        this.digest(file, sessionId, project, String(line.type ?? 'unknown'));
    }
  }

  /**
   * The boss's screen shows the prompt itself, verbatim. `preview` is the head
   * of the real text (clipped only so one status-board line can't swallow the
   * board); the untruncated prompt rides along as the inbox item's fullText, and
   * the focus camera scrolls it.
   *
   * This used to fire an LLM summary that rewrote both strings a second later.
   * That is gone on purpose — no generated text, no second write.
   */
  private onUserPrompt(project: string, text: string, uuid?: string) {
    this.stats?.recordPrompt(uuid);
    const preview = text.length > 160 ? text.slice(0, 157) + '…' : text;
    this.office.pushInbox(project, preview, text.slice(0, 4000));
    this.office.pushStatus('boss', `Message from upstairs: ${preview}`);
  }

  /** The main Claude's own text/thinking: an employee walks it over to the Boss. */
  private onBossReply(sessionId: string, project: string, line: any, blocks: any[]) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking?.trim()) parts.push('💭 ' + b.thinking.trim());
      else if (b.type === 'redacted_thinking') parts.push('💭 [redacted]');
      else if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
    }
    if (parts.length === 0) return;
    this.touchBoss();
    // uuid-based key so replayed lines dedupe via office.assign's existing-key check
    this.showEphemeral(sessionId, project, 'Reporting to the Boss', parts.join('\n'), {
      key: `${sessionId}:${line.uuid ?? `reply-${++this.replySeq}`}`,
    });
  }

  private startTool(sessionId: string, project: string, tu: any) {
    const toolUseId: string = tu.id;
    const name: string = tu.name ?? 'Tool';
    const input = tu.input ?? {};

    if (name === 'TodoWrite') {
      if (Array.isArray(input.todos)) this.office.setTodos(project, input.todos);
      return;
    }
    // Task-list management tools update the whiteboard instead of claiming an employee.
    if (name === 'TaskCreate') {
      this.pendingTaskCreates.set(toolUseId, { project, subject: input.subject ?? '(task)' });
      return;
    }
    if (name === 'TaskUpdate') {
      this.pendingTaskUpdates.set(toolUseId, {
        project,
        taskId: String(input.taskId ?? ''),
        status: input.status,
        subject: input.subject,
      });
      return;
    }
    if (name === 'TaskList' || name === 'TaskGet' || name === 'TaskStop' || name === 'TaskOutput') return;

    if (this.activities.has(toolUseId)) return;

    const isTask = name === 'Task' || name === 'Agent';
    const label = isTask ? `Agent: ${input.description ?? input.subagent_type ?? 'subagent'}` : name;
    const activity = this.startToolActivity(sessionId, project, tu, label);

    // Task-file matching stays here (not in the shared core): fanned-out subagent
    // tools never reach this branch, since Task/Agent are excluded from fan-out.
    let attachFile: string | undefined;
    if (isTask) {
      const file = this.unmatchedAgentFiles.get(sessionId)?.shift();
      if (file) {
        attachFile = file;
      } else {
        const pending = this.pendingTasks.get(sessionId) ?? [];
        pending.push(activity);
        this.pendingTasks.set(sessionId, pending);
      }
    }

    // Attach (and replay any buffered lines) only after the clear/title/input
    // preview are queued, so a pooled file's backlog renders after them, not before.
    if (attachFile) {
      this.attachAgentFile(activity, attachFile);
    }
  }

  /**
   * Shared core for claiming an employee/desk for a tool_use, used by both the main-session
   * flow (`startTool`) and subagent fan-out (`handleSubagentLine`). `tu` needs only `id`,
   * `name`, and `input` (the same shape in both contexts).
   */
  private startToolActivity(sessionId: string, project: string, tu: any, label: string): Activity {
    const toolUseId: string = tu.id;
    const name: string = tu.name ?? 'Tool';
    const input = tu.input ?? {};
    const isTask = name === 'Task' || name === 'Agent';

    const { employee, hired } = this.office.assign(`${sessionId}:${toolUseId}`, label);
    const activity: Activity = {
      key: `${sessionId}:${toolUseId}`,
      employeeId: employee?.id ?? null,
      tool: name,
      isTask,
      sessionId,
      project,
    };
    if (isTask) activity.children = new Set();
    if (!employee) {
      activity.pendingTitle = `${label} · ${project}`;
      activity.buffer = [];
      this.queued.set(activity.key, activity);
    }
    this.activities.set(toolUseId, activity);

    if (hired && employee && employee.name === 'New Hire') {
      const n = this.office.pickHireName();
      this.office.rename(employee.id, n);
      this.office.pushStatus('hire', `New hire: ${n} joined the office`);
    }

    if (employee) {
      this.office.monitor(employee.id, { clear: true, title: `${label} · ${project}` });
      this.streamer.enqueue(employee.id, inputPreview(name, input));
    } else {
      this.emitTo(activity, inputPreview(name, input));
    }

    return activity;
  }

  private finishTool(result: any, ctx?: { toolUseResult?: any; toolDenialKind?: string }) {
    const toolUseId: string = result.tool_use_id;

    const create = this.pendingTaskCreates.get(toolUseId);
    if (create) {
      this.pendingTaskCreates.delete(toolUseId);
      const id = extractText(result.content).match(/#(\d+)/)?.[1];
      if (id) {
        this.taskMap(create.project).set(id, { content: create.subject, status: 'pending' });
        this.pushTaskBoard(create.project);
      }
      return;
    }
    const update = this.pendingTaskUpdates.get(toolUseId);
    if (update) {
      this.pendingTaskUpdates.delete(toolUseId);
      const map = this.taskMap(update.project);
      const task = map.get(update.taskId);
      if (task) {
        if (update.status === 'deleted') map.delete(update.taskId);
        else if (update.status) task.status = update.status as TrackedTask['status'];
        if (update.subject) task.content = update.subject;
        this.pushTaskBoard(update.project);
      }
      return;
    }

    const activity = this.activities.get(toolUseId);
    if (!activity) return;
    this.activities.delete(toolUseId);
    activity.parentTask?.children?.delete(toolUseId);
    if (activity.agentFile) {
      this.agentFiles.delete(activity.agentFile);
      this.bufferedLines.delete(activity.agentFile);
      this.finishedAgentFiles.add(activity.agentFile);
    }
    // A finishing Task's subagent tool_result stream can race the file-teardown above
    // (finishedAgentFiles) or never arrive at all; close any children still open so
    // their desks don't stay "working" forever.
    if (activity.children?.size) {
      const openChildren = [...activity.children]
        .map((id): [string, Activity] | undefined => {
          const child = this.activities.get(id);
          return child ? [id, child] : undefined;
        })
        .filter((pair): pair is [string, Activity] => pair !== undefined);
      // Cancel every still-queued sibling FIRST, in its own pass. office.finish on an
      // assigned sibling synchronously dequeues+reassigns the office's work queue
      // (onQueuedAssigned), which would flip a still-queued sibling's employeeId out
      // from under a single combined loop before we got to it — misclassifying real,
      // just-assigned work as "already done". cancelQueued has no reentrant callback,
      // so once this pass is done no sibling can be dequeued mid-loop.
      for (const [id, child] of openChildren) {
        if (child.employeeId) continue;
        this.activities.delete(id);
        this.queued.delete(child.key);
        this.office.cancelQueued(child.key);
      }
      for (const [id, child] of openChildren) {
        if (!child.employeeId) continue;
        this.activities.delete(id);
        this.emitTo(child, '✓ done');
        this.office.finish(child.key);
      }
      activity.children.clear();
    }
    for (const [sid, list] of this.pendingTasks) {
      this.pendingTasks.set(sid, list.filter((a) => a !== activity));
    }

    for (const img of extractImages(result.content)) {
      this.emitTo(activity, MONITOR_IMAGE_MARKER + img);
    }
    let text = stripSystemReminders(extractText(result.content));
    // Edit/Write results are just "File updated" — the sidecar's patch is the real story
    const patch = ctx?.toolUseResult?.structuredPatch;
    if ((activity.tool === 'Edit' || activity.tool === 'Write') && Array.isArray(patch)) {
      const rendered = capLines(renderPatch(patch), 30);
      if (rendered.trim()) text = rendered;
    }
    const terminal = ctx?.toolDenialKind
      ? `✗ blocked (${ctx.toolDenialKind})`
      : result.is_error
        ? '✗ failed'
        : '✓ done';
    this.emitTo(activity, (text || '(no output)') + '\n\n' + terminal);
    // subagent jobs are status-board-worthy; per-tool finishes would be a firehose
    if (activity.isTask && activity.employeeId && !ctx?.toolDenialKind && !result.is_error) {
      const emp = this.office.employeeFor(activity.key);
      if (emp?.task) this.office.pushStatus('done', `${emp.name} finished ${emp.task}`);
    }
    if (activity.employeeId) this.office.finish(activity.key);
    else activity.doneWhileQueued = true;
  }

  private taskMap(project: string): Map<string, TrackedTask> {
    let map = this.tasks.get(project);
    if (!map) {
      map = new Map();
      this.tasks.set(project, map);
    }
    return map;
  }

  private pushTaskBoard(project: string) {
    const map = this.taskMap(project);
    const items = [...map.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, t]) => t);
    this.office.setTodos(project, items);
  }

  private handleSubagentLine(activity: Activity, line: any) {
    if (line.type === 'assistant') {
      if (line.message?.usage) this.stats?.recordUsage(line.message?.id ?? line.requestId, line.message?.model, line.message.usage);
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          this.emitTo(activity, b.text.trim());
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          this.emitTo(activity, '💭 ' + b.thinking.trim());
        } else if (b.type === 'tool_use') {
          this.stats?.recordTool(b.name, b.id);
          if (FANOUT_EXCLUDED.has(b.name)) {
            this.emitTo(activity, `> ${b.name} ${oneLine(inputPreview(b.name, b.input ?? {}))}`);
            continue;
          }
          // Duplicate/replayed line (same toolUseId already fanned out): skip entirely,
          // breadcrumb included, mirroring startTool's own activities.has dedupe guard.
          if (this.activities.has(b.id)) continue;
          // Fan out: this subagent tool gets its own employee/monitor via the same
          // machinery main-session tools use; the Task's screen just gets a breadcrumb.
          this.emitTo(activity, `> ${b.name}`);
          const child = this.startToolActivity(activity.sessionId, activity.project, b, b.name);
          child.parentTask = activity;
          activity.children?.add(b.id);
        }
      }
      return;
    }
    if (line.type === 'user') {
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type !== 'tool_result') continue;
        if (this.activities.has(b.tool_use_id)) {
          // A fanned-out child's result: route through the normal finishTool path
          // (safe — pendingTaskCreates/Updates only ever hold main-session ids).
          this.finishTool(b, { toolUseResult: line.toolUseResult, toolDenialKind: line.toolDenialKind });
          continue;
        }
        for (const img of extractImages(b.content)) {
          this.emitTo(activity, MONITOR_IMAGE_MARKER + img);
        }
        const text = stripSystemReminders(extractText(b.content));
        if (text) this.emitTo(activity, b.is_error ? '✗ ' + text : text);
      }
    }
  }
}

/* ----------------------------- helpers ----------------------------- */

function isSubagentFile(file: string): boolean {
  return file.includes(`${path.sep}subagents${path.sep}`);
}

function sessionIdForSubagentFile(file: string): string {
  // .../<sessionId>/subagents/agent-x.jsonl
  return path.basename(path.dirname(path.dirname(file)));
}

function projectName(cwd: string | undefined, file: string): string {
  if (cwd) return path.basename(cwd);
  const dir = path.basename(path.dirname(file));
  const parts = dir.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function contentBlocks(content: any): any[] {
  return Array.isArray(content) ? content : [];
}

function extractText(content: any): string {
  if (typeof content === 'string') return content.trim();
  return contentBlocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

/** Image blocks in a message/tool_result (e.g. Read on a PNG) as data URLs or plain URLs. */
function extractImages(content: any): string[] {
  const out: string[] = [];
  for (const b of contentBlocks(content)) {
    if (b.type !== 'image') continue;
    if (b.source?.type === 'base64' && b.source.data) {
      out.push(`data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}`);
    } else if (b.source?.type === 'url' && b.source.url) {
      out.push(b.source.url);
    }
  }
  return out;
}

function capLines(s: string, max: number): string {
  const lines = s.split('\n');
  if (lines.length <= max) return s;
  return lines.slice(0, max).join('\n') + '\n…';
}

function firstLine(s: string, max: number): string {
  const l = s.split('\n')[0].trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}

/** Inner content of the first <tag>…</tag> span, or undefined when absent. */
function tagContent(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Harness system-reminder spans embedded inside tool_result text are host noise, not output. */
function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** attachment content fields arrive as a string or an array of strings/text blocks */
function flattenContent(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('\n');
  }
  return '';
}

/** structuredPatch hunks (from the toolUseResult sidecar) as +/- diff lines */
function renderPatch(patch: any[]): string {
  const lines: string[] = [];
  for (const hunk of patch) {
    if (Array.isArray(hunk?.lines)) lines.push(...hunk.lines);
  }
  return lines.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function inputPreview(tool: string, input: Record<string, any>): string {
  switch (tool) {
    case 'Bash':
      return `$ ${input.command ?? ''}`;
    case 'Read':
      return `read ${input.file_path ?? ''}`;
    case 'Write': {
      const body = capLines(String(input.content ?? ''), 15);
      return `write ${input.file_path ?? ''}${body ? '\n' + body : ''}`;
    }
    case 'Edit': {
      const old = capLines(String(input.old_string ?? ''), 8);
      const neu = capLines(String(input.new_string ?? ''), 8);
      const parts = [`edit ${input.file_path ?? ''}`];
      if (old) parts.push(old.split('\n').map((l) => '- ' + l).join('\n'));
      if (neu) parts.push(neu.split('\n').map((l) => '+ ' + l).join('\n'));
      return parts.join('\n');
    }
    case 'Grep':
      return `grep ${input.pattern ?? ''} ${input.path ?? ''}`;
    case 'Glob':
      return `glob ${input.pattern ?? ''}`;
    case 'WebSearch':
      return `search: ${input.query ?? ''}`;
    case 'WebFetch':
      return `fetch ${input.url ?? ''}`;
    case 'Task':
    case 'Agent':
      return input.prompt ?? input.description ?? '';
    default: {
      return capLines(JSON.stringify(input, null, 1) ?? '', 10);
    }
  }
}
