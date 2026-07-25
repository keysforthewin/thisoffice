import path from 'node:path';
import type { Office } from './office.ts';
import type { ScreenStreamer } from './streamer.ts';
import { summarizePrompt, nameNewHire } from './summarizer.ts';

/**
 * Turns raw Claude Code transcript JSONL lines into office activity.
 *
 * Files look like:
 *   ~/.claude/projects/<proj-dir>/<sessionId>.jsonl                    main session
 *   ~/.claude/projects/<proj-dir>/<sessionId>/subagents/agent-*.jsonl  subagent transcripts
 */

interface Activity {
  key: string; // sessionId:toolUseId
  employeeId: string;
  tool: string;
  isTask: boolean;
  agentFile?: string;
}

interface TrackedTask {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const BOSS_IDLE_MS = 8000;
const MAX_BUFFERED_LINES = 500;

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

  constructor(
    private office: Office,
    private streamer: ScreenStreamer,
  ) {}

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

    if (line.type === 'user') {
      const content = line.message?.content;
      // tool results come back as user-role messages
      const results = contentBlocks(content).filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        for (const r of results) this.finishTool(r);
        this.touchBoss();
        return;
      }
      if (line.isMeta) return;
      const text = extractText(content);
      if (!text || text.startsWith('<')) return; // command/meta messages
      this.touchBoss();
      this.onUserPrompt(project, text);
      return;
    }

    if (line.type === 'assistant') {
      const blocks = contentBlocks(line.message?.content);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      if (toolUses.length > 0) this.touchBoss();
      for (const tu of toolUses) this.startTool(sessionId, project, tu);
      this.onBossReply(sessionId, project, line, blocks);
    }
  }

  private onUserPrompt(project: string, text: string) {
    const preview = text.length > 160 ? text.slice(0, 157) + '…' : text;
    this.office.pushInbox(project, preview);
    const inboxId = this.office.lastInboxId;
    summarizePrompt(text).then((summary) => {
      if (summary) this.office.updateInboxText(inboxId, summary);
    });
  }

  /** The main Claude's own text/thinking: an employee walks it over to the Boss. */
  private onBossReply(sessionId: string, project: string, line: any, blocks: any[]) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking?.trim()) parts.push('💭 ' + b.thinking.trim());
      else if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
    }
    if (parts.length === 0) return;
    this.touchBoss();
    const key = `${sessionId}:${line.uuid ?? `reply-${++this.replySeq}`}`;
    const { employee, hired } = this.office.assign(key, 'Reporting to the Boss');
    if (!employee) return; // TODO(task 5): buffer queued activity
    if (hired) {
      nameNewHire('Reporting to the Boss').then((name) => {
        if (name) this.office.rename(employee.id, name);
      });
    }
    this.office.monitor(employee.id, { clear: true, title: `Reporting to the Boss · ${project}` });
    this.streamer.enqueue(employee.id, parts.join('\n'));
    this.office.finish(key);
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
    const { employee, hired } = this.office.assign(`${sessionId}:${toolUseId}`, label);
    if (!employee) return; // TODO(task 5): buffer queued activity
    const activity: Activity = { key: `${sessionId}:${toolUseId}`, employeeId: employee.id, tool: name, isTask };
    this.activities.set(toolUseId, activity);

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

    if (hired) {
      nameNewHire(label).then((name) => {
        if (name) this.office.rename(employee.id, name);
      });
    }

    this.office.monitor(employee.id, { clear: true, title: `${label} · ${project}` });
    this.streamer.enqueue(employee.id, inputPreview(name, input));

    // Attach (and replay any buffered lines) only after the clear/title/input
    // preview are queued, so a pooled file's backlog renders after them, not before.
    if (attachFile) {
      this.attachAgentFile(activity, attachFile);
    }
  }

  private finishTool(result: any) {
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
    if (activity.agentFile) {
      this.agentFiles.delete(activity.agentFile);
      this.bufferedLines.delete(activity.agentFile);
      this.finishedAgentFiles.add(activity.agentFile);
    }
    for (const [sid, list] of this.pendingTasks) {
      this.pendingTasks.set(sid, list.filter((a) => a !== activity));
    }

    const text = extractText(result.content) || '(no output)';
    this.streamer.enqueue(activity.employeeId, text + '\n\n✓ done');
    this.office.finish(activity.key);
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
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          this.streamer.enqueue(activity.employeeId, b.text.trim());
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          this.streamer.enqueue(activity.employeeId, '💭 ' + b.thinking.trim());
        } else if (b.type === 'tool_use') {
          this.streamer.enqueue(activity.employeeId, `> ${b.name} ${oneLine(inputPreview(b.name, b.input ?? {}))}`);
        }
      }
      return;
    }
    if (line.type === 'user') {
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type !== 'tool_result') continue;
        const text = extractText(b.content);
        if (text) this.streamer.enqueue(activity.employeeId, text);
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

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function inputPreview(tool: string, input: Record<string, any>): string {
  switch (tool) {
    case 'Bash':
      return `$ ${input.command ?? ''}`;
    case 'Read':
      return `read ${input.file_path ?? ''}`;
    case 'Write':
      return `write ${input.file_path ?? ''}`;
    case 'Edit':
      return `edit ${input.file_path ??  ''}`;
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
      return JSON.stringify(input, null, 1) ?? '';
    }
  }
}
