// Local records: mute preference, all-time medals, personal bests.
// Fixed-Arcade bests are kept separate from per-seed Remix bests, and only
// an unassisted (no-continue) Arcade clear can set the Arcade ranked best.
// If browser storage is unavailable the in-memory copy still works for the
// session, so gameplay/retry never depends on localStorage.

export interface BestRecord {
  score: number;
  timeSec: number;
  rank: string;
}

export interface Records {
  muted: boolean;
  medals: string[];
  arcadeBest: BestRecord | null;
  remixBests: Record<string, BestRecord>;
}

const KEY = 'red-cliffs-ablaze.v1';

const memory: Records = { muted: false, medals: [], arcadeBest: null, remixBests: {} };
let loaded = false;

function load(): Records {
  if (!loaded) {
    loaded = true;
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Records>;
        if (typeof parsed.muted === 'boolean') memory.muted = parsed.muted;
        if (Array.isArray(parsed.medals)) memory.medals = parsed.medals.filter((m) => typeof m === 'string');
        if (parsed.arcadeBest && typeof parsed.arcadeBest.score === 'number') memory.arcadeBest = parsed.arcadeBest;
        if (parsed.remixBests && typeof parsed.remixBests === 'object') memory.remixBests = parsed.remixBests;
      }
    } catch {
      // Storage unavailable (private mode, sandboxed iframe, ...): session-only.
    }
  }
  return memory;
}

function save(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Session-only fallback; gameplay continues regardless.
  }
}

export const records = {
  get muted(): boolean {
    return load().muted;
  },
  setMuted(muted: boolean): void {
    load().muted = muted;
    save();
  },
  medals(): string[] {
    return [...load().medals];
  },
  earnMedal(id: string): void {
    const r = load();
    if (!r.medals.includes(id)) {
      r.medals.push(id);
      save();
    }
  },
  arcadeBest(): BestRecord | null {
    return load().arcadeBest;
  },
  remixBest(seed: number): BestRecord | null {
    return load().remixBests[String(seed)] ?? null;
  },
  /** Returns true when the run set a new best. Arcade requires no continues. */
  submitBest(mode: 'arcade' | 'remix', seed: number, best: BestRecord, continues: number): boolean {
    const r = load();
    if (mode === 'arcade') {
      if (continues > 0) return false;
      if (!r.arcadeBest || best.score > r.arcadeBest.score) {
        r.arcadeBest = best;
        save();
        return true;
      }
      return false;
    }
    const k = String(seed);
    if (!r.remixBests[k] || best.score > r.remixBests[k].score) {
      r.remixBests[k] = best;
      save();
      return true;
    }
    return false;
  },
  snapshot(): Records {
    const r = load();
    return {
      muted: r.muted,
      medals: [...r.medals],
      arcadeBest: r.arcadeBest,
      remixBests: { ...r.remixBests },
    };
  },
};
