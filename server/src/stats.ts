import fs from 'node:fs';
import path from 'node:path';
import type { DayStats, UsageStats } from '../../shared/types.ts';

/**
 * FIFO caps for the persisted dedupe rings — enough to survive a restart mid-response/session,
 * and (crucially) to survive a resume/fork/compact replay, which copies prior history lines
 * (same uuids/message ids/tool_use ids) into a NEW jsonl file the watcher reads from offset 0.
 * Entries are tiny (a few dozen bytes each), so these are sized generously against long
 * sessions rather than trimmed for file size.
 */
const LAST_USAGE_MAX = 5000;
const RECENT_SESSIONS_MAX = 200;
const RECENT_TOOL_IDS_MAX = 5000;
const RECENT_PROMPT_IDS_MAX = 2000;
const RECENT_TURN_IDS_MAX = 2000;
/** byDay is pruned to this window on every write. */
const BYDAY_MAX_DAYS = 30;

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  webSearches: number;
  webFetches: number;
}

interface RecordedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

interface PersistedFile {
  stats: UsageStats;
  /** msgId -> last-seen cumulative snapshot, insertion order = FIFO eviction order */
  recentMsgIds: Array<[string, UsageSnapshot]>;
  /** most-recently-seen session ids, FIFO capped */
  recentSessionIds: string[];
  /** most-recently-seen tool_use ids, FIFO capped — guards recordTool against replay */
  recentToolUseIds?: string[];
  /** most-recently-seen user-prompt line uuids, FIFO capped — guards recordPrompt against replay */
  recentPromptIds?: string[];
  /** most-recently-seen turn_duration line uuids, FIFO capped — guards recordTurn against replay */
  recentTurnIds?: string[];
}

/** Simple FIFO-capped id-dedupe ring: a Set for O(1) membership plus an array for eviction order. */
class IdRing {
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(private max: number, initial: string[] = []) {
    for (const id of initial) this.addIfNew(id);
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Records `id`; returns false (no-op) if it was already seen, true if newly recorded. */
  addIfNew(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  toArray(): string[] {
    return this.order;
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  return Math.round((tb - ta) / 86_400_000);
}

function emptyStats(): UsageStats {
  return {
    trackingSince: new Date().toISOString(),
    tokensByModel: {},
    toolCalls: {},
    prompts: 0,
    sessions: 0,
    subagents: 0,
    webSearches: 0,
    webFetches: 0,
    turns: 0,
    turnMsTotal: 0,
    longestTurnMs: 0,
    peakHeadcount: 0,
    headcount: 0,
    byDay: {},
    hourCounts: {},
    tokensByDowHour: {},
    gameWins: {},
    charsByEmployee: {},
  };
}

export class StatsAggregator {
  private stats: UsageStats;
  /** msgId -> last-seen cumulative snapshot; insertion-ordered Map gives us FIFO eviction for free. */
  private lastUsage = new Map<string, UsageSnapshot>();
  private seenSessions = new Set<string>();
  /** insertion order of seenSessions, capped, for persistence */
  private recentSessionIds: string[] = [];
  /** tool_use id dedupe ring: same id must never count twice, even across a resume/fork replay. */
  private recentToolUseIds = new IdRing(RECENT_TOOL_IDS_MAX);
  /** user-prompt line uuid dedupe ring, same replay guarantee. */
  private recentPromptIds = new IdRing(RECENT_PROMPT_IDS_MAX);
  /** turn_duration line uuid dedupe ring, same replay guarantee. */
  private recentTurnIds = new IdRing(RECENT_TURN_IDS_MAX);
  private dirty = false;

  constructor(private dataFile: string) {
    this.stats = this.load();
  }

  private load(): UsageStats {
    let persisted: PersistedFile | null = null;
    try {
      persisted = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
    } catch (err) {
      if (fs.existsSync(this.dataFile)) {
        // eslint-disable-next-line no-console
        console.warn(`[stats] failed to parse ${this.dataFile}, starting fresh:`, err);
      }
      persisted = null;
    }
    if (!persisted || typeof persisted !== 'object' || !persisted.stats) {
      return emptyStats();
    }
    for (const [id, snap] of persisted.recentMsgIds ?? []) {
      this.lastUsage.set(id, snap);
    }
    this.recentSessionIds = Array.isArray(persisted.recentSessionIds) ? persisted.recentSessionIds : [];
    for (const id of this.recentSessionIds) this.seenSessions.add(id);
    // migrating/ignoring files from before these rings existed is fine — they just
    // start empty and the dedupe window fills back up from here.
    this.recentToolUseIds = new IdRing(RECENT_TOOL_IDS_MAX, persisted.recentToolUseIds ?? []);
    this.recentPromptIds = new IdRing(RECENT_PROMPT_IDS_MAX, persisted.recentPromptIds ?? []);
    this.recentTurnIds = new IdRing(RECENT_TURN_IDS_MAX, persisted.recentTurnIds ?? []);
    const stats = persisted.stats;
    // defensive defaults in case the file predates a field
    return { ...emptyStats(), ...stats };
  }

  private markDirty() {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Structured-clone-safe snapshot; excludes the private dedupe rings, which live only in the file. */
  snapshot(): UsageStats {
    return JSON.parse(JSON.stringify(this.stats));
  }

  private dayBucket(day: string): DayStats {
    let bucket = this.stats.byDay[day];
    if (!bucket) {
      bucket = { tokens: 0, toolCalls: 0, prompts: 0 };
      this.stats.byDay[day] = bucket;
    }
    return bucket;
  }

  /** Drop byDay keys older than the retention window. */
  private pruneByDay() {
    const today = todayKey();
    for (const key of Object.keys(this.stats.byDay)) {
      if (daysBetween(key, today) > BYDAY_MAX_DAYS) delete this.stats.byDay[key];
    }
  }

  /**
   * Claude Code transcript JSONL repeats message.usage on every streamed
   * content-block line of one assistant response, with CUMULATIVE values.
   * We keep the last-seen snapshot per msgId and fold only the per-field
   * delta, so replaying an identical line (or restarting mid-response with
   * the same cumulative totals) never double-counts.
   */
  recordUsage(msgId: string | undefined, model: string | undefined, usage: RecordedUsage | undefined): void {
    if (!usage || !msgId) return;
    const resolvedModel = model ?? 'unknown';
    if (resolvedModel === '<synthetic>') return;

    const next: UsageSnapshot = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      webFetches: usage.server_tool_use?.web_fetch_requests ?? 0,
    };
    const prev = this.lastUsage.get(msgId) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      webSearches: 0,
      webFetches: 0,
    };

    const dInput = Math.max(0, next.input - prev.input);
    const dOutput = Math.max(0, next.output - prev.output);
    const dCacheRead = Math.max(0, next.cacheRead - prev.cacheRead);
    const dCacheCreation = Math.max(0, next.cacheCreation - prev.cacheCreation);
    const dWebSearches = Math.max(0, next.webSearches - prev.webSearches);
    const dWebFetches = Math.max(0, next.webFetches - prev.webFetches);

    let bucket = this.stats.tokensByModel[resolvedModel];
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      this.stats.tokensByModel[resolvedModel] = bucket;
    }
    bucket.input += dInput;
    bucket.output += dOutput;
    bucket.cacheRead += dCacheRead;
    bucket.cacheCreation += dCacheCreation;

    this.stats.webSearches += dWebSearches;
    this.stats.webFetches += dWebFetches;

    if (dInput + dOutput > 0) {
      this.dayBucket(todayKey()).tokens += dInput + dOutput;
      // UTC weekday+hour, same clock and same reasoning as hourCounts
      const now = new Date();
      const key = `${now.getUTCDay()}-${now.getUTCHours()}`;
      this.stats.tokensByDowHour[key] = (this.stats.tokensByDowHour[key] ?? 0) + dInput + dOutput;
    }

    // update (or insert) the msgId snapshot; re-inserting on update keeps it
    // "fresh" for FIFO eviction ordering
    this.lastUsage.delete(msgId);
    this.lastUsage.set(msgId, next);
    if (this.lastUsage.size > LAST_USAGE_MAX) {
      const oldest = this.lastUsage.keys().next().value;
      if (oldest !== undefined) this.lastUsage.delete(oldest);
    }

    this.pruneByDay();
    this.markDirty();
  }

  /**
   * `toolUseId` dedupes against resume/fork/compact replay (same jsonl content copied
   * into a new file, read from offset 0). Every real tool_use block carries an id; it's
   * optional only for defensiveness against malformed/legacy lines, in which case we
   * fall back to counting without dedupe.
   */
  recordTool(name: string, toolUseId?: string): void {
    if (toolUseId && !this.recentToolUseIds.addIfNew(toolUseId)) return; // replayed line
    this.stats.toolCalls[name] = (this.stats.toolCalls[name] ?? 0) + 1;
    this.dayBucket(todayKey()).toolCalls++;
    // must mirror transcript.ts's `isTask` check (see transcript.ts:653) so the two
    // never drift on what counts as a subagent launch
    if (name === 'Task' || name === 'Agent') this.stats.subagents++;
    this.pruneByDay();
    this.markDirty();
  }

  /** `uuid` is the record's own line uuid; same replay guard as recordTool. */
  recordPrompt(uuid?: string): void {
    if (uuid && !this.recentPromptIds.addIfNew(uuid)) return; // replayed line
    this.stats.prompts++;
    this.dayBucket(todayKey()).prompts++;
    // UTC, like todayKey() — the server may run in a different zone than the viewer
    // (it does in Docker: the container is UTC), so the client shifts to browser-local.
    const hour = String(new Date().getUTCHours());
    this.stats.hourCounts[hour] = (this.stats.hourCounts[hour] ?? 0) + 1;
    this.pruneByDay();
    this.markDirty();
  }

  /** Counts each distinct session id once, even across server restarts. */
  recordSession(sessionId: string): void {
    if (this.seenSessions.has(sessionId)) return;
    this.seenSessions.add(sessionId);
    this.recentSessionIds.push(sessionId);
    if (this.recentSessionIds.length > RECENT_SESSIONS_MAX) {
      const dropped = this.recentSessionIds.shift();
      if (dropped !== undefined) this.seenSessions.delete(dropped);
    }
    this.stats.sessions++;
    this.markDirty();
  }

  /** `uuid` is the turn_duration record's own line uuid; same replay guard as recordTool. */
  recordTurn(durationMs: number, uuid?: string): void {
    if (uuid && !this.recentTurnIds.addIfNew(uuid)) return; // replayed line
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.stats.turns++;
    this.stats.turnMsTotal += durationMs;
    this.stats.longestTurnMs = Math.max(this.stats.longestTurnMs, durationMs);
    this.markDirty();
  }

  recordHeadcount(n: number): void {
    // only dirty the file (and the 15s broadcast/flush cycle) when something actually
    // moves — otherwise an idle office with a stable headcount flushes/broadcasts forever.
    const changed = n !== this.stats.headcount || n > this.stats.peakHeadcount;
    if (!changed) return;
    this.stats.headcount = n;
    this.stats.peakHeadcount = Math.max(this.stats.peakHeadcount, n);
    this.markDirty();
  }

  /** A 20 Questions round was won. Keyed by name so a rehired employee keeps her wins. */
  recordGameWin(name: string): void {
    const key = name.trim();
    if (!key) return;
    this.stats.gameWins[key] = (this.stats.gameWins[key] ?? 0) + 1;
    this.markDirty();
  }

  /** Text that reached an employee's monitor. Keyed by name like recordGameWin, so a
   *  rehired seat keeps its tally. Called on every streamed chunk, hence the cheap
   *  guard: no name or no characters means no write and no dirty flag. */
  recordChars(name: string, n: number): void {
    const key = name.trim();
    if (!key || !Number.isFinite(n) || n <= 0) return;
    this.stats.charsByEmployee[key] = (this.stats.charsByEmployee[key] ?? 0) + n;
    this.markDirty();
  }

  /** Synchronous, atomic-ish write (tmp file + rename) so a crash mid-write can't corrupt the file. */
  flush(): void {
    const persisted: PersistedFile = {
      stats: this.stats,
      recentMsgIds: [...this.lastUsage.entries()],
      recentSessionIds: this.recentSessionIds,
      recentToolUseIds: this.recentToolUseIds.toArray(),
      recentPromptIds: this.recentPromptIds.toArray(),
      recentTurnIds: this.recentTurnIds.toArray(),
    };
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, this.dataFile);
    this.dirty = false;
  }
}
