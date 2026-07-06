import type { Entry, Tag } from './classify';

export type ReduceMode =
  | { kind: 'all' }
  | { kind: 'unique' }
  | { kind: 'debounce'; windowMs: number };

export interface OutputLine {
  time: string;
  tag: Tag;
  domain: string;
  count?: number;
  since?: string;
}

interface KeyState {
  lastPrintedMs: number;
  lastPrintedTime: string;
  suppressed: number;
}

function keyOf(entry: Entry): string {
  return `${entry.tag} ${entry.domain}`;
}

function plain(entry: Entry): OutputLine {
  return { time: entry.time, tag: entry.tag, domain: entry.domain };
}

export class Reducer {
  private readonly seen = new Map<string, KeyState>();

  constructor(private readonly mode: ReduceMode) {}

  push(entry: Entry): OutputLine[] {
    if (this.mode.kind === 'all') return [plain(entry)];

    const key = keyOf(entry);
    const nowMs = Date.parse(entry.time);
    const state = this.seen.get(key);

    if (!state) {
      this.seen.set(key, {
        lastPrintedMs: nowMs,
        lastPrintedTime: entry.time,
        suppressed: 0,
      });
      return [plain(entry)];
    }

    if (this.mode.kind === 'unique') return [];

    if (nowMs - state.lastPrintedMs >= this.mode.windowMs) {
      const out: OutputLine = {
        time: entry.time,
        tag: entry.tag,
        domain: entry.domain,
        count: state.suppressed,
        since: state.lastPrintedTime,
      };
      state.lastPrintedMs = nowMs;
      state.lastPrintedTime = entry.time;
      state.suppressed = 0;
      return [out];
    }

    state.suppressed += 1;
    return [];
  }
}
