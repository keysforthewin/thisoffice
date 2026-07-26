import type { InboxItem } from '../../../shared/types.ts';

/**
 * A prompt's arrival time as the viewer's wall clock, e.g. `1:05 AM`.
 *
 * `InboxItem.at` is an ISO-8601 UTC stamp, and the server may well be in a
 * different zone than whoever is watching — in Docker it is UTC. Slicing the
 * hour out of the string showed the server's clock, not the viewer's (1 AM in
 * New York rendered as "05:00"), so it has to go through a real Date.
 *
 * `en-US` is pinned rather than deferring to the viewer's locale so the 12-hour
 * AM/PM reading is guaranteed; `timeZone` is for tests, which need a fixed zone
 * to assert exact strings — production uses the viewer's own.
 */
export function formatInboxTime(at: string, timeZone?: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
}

/**
 * The boss monitor's scrollable log: every inbox message in full, oldest first,
 * so the live tail is the newest message. Rendered through the same wrap /
 * visibleRows machinery as employee scrollback.
 */
export function bossScreenLines(inbox: InboxItem[], timeZone?: string): string[] {
  const out: string[] = [];
  for (const item of inbox) {
    out.push(`▸ [${item.project}] ${formatInboxTime(item.at, timeZone)}`);
    out.push(...(item.fullText ?? item.text).split('\n'));
    out.push('');
  }
  return out;
}
