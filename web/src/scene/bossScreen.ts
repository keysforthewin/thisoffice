import type { InboxItem } from '../../../shared/types.ts';

/**
 * The boss monitor's scrollable log: every inbox message in full, oldest first,
 * so the live tail is the newest message. Rendered through the same wrap /
 * visibleRows machinery as employee scrollback.
 */
export function bossScreenLines(inbox: InboxItem[]): string[] {
  const out: string[] = [];
  for (const item of inbox) {
    out.push(`▸ [${item.project}] ${item.at.slice(11, 16)}`);
    out.push(...(item.fullText ?? item.text).split('\n'));
    out.push('');
  }
  return out;
}
