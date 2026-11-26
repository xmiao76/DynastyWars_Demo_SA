// Pure game data for Red Cliffs Ablaze: move tables, enemy stats, authored
// stage sections (fixed Arcade baseline + Remix variants), score/rank math
// and the seeded RNG. No Phaser imports, so the encounter selection and
// scoring rules stay testable in isolation.

export const WORLD_W = 6200;
export const GROUND_TOP = 398;
export const GROUND_BOT = 498;
export const DEPTH_TOLERANCE = 30;

export type EnemyKind = 'sword' | 'spear' | 'archer' | 'brute' | 'yujin';
export type FighterKind = 'player' | EnemyKind;

export interface AttackSpec {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  reach: number;
  knockback: number;
  knockdown: boolean;
  /** Heavy blows interrupt armored wind-ups (Brute / Yu Jin). */
  heavy?: boolean;
  /** Depth-lane tolerance override (Dragon Cleave is slightly wider). */
  laneTol?: number;
  /** Hit targets on both sides (Dragon Cleave). */
  bothSides?: boolean;
}

// Guan Yu's attack sprite strikes at ~55% of the clip; the animation is
// time-scaled to span startup+active+recovery exactly (as in the baseline).
export const PLAYER_COMBO: AttackSpec[] = [
  { startup: 130, active: 80, recovery: 100, damage: 7, reach: 100, knockback: 120, knockdown: false }, // shaft jab
  { startup: 130, active: 80, recovery: 100, damage: 8, reach: 102, knockback: 140, knockdown: false }, // slash
  { startup: 150, active: 90, recovery: 120, damage: 10, reach: 105, knockback: 180, knockdown: false }, // rising slash
  { startup: 190, active: 110, recovery: 210, damage: 15, reach: 112, knockback: 340, knockdown: true, heavy: true }, // heavy knockdown
];
export const AIR_NEUTRAL: AttackSpec = { startup: 120, active: 130, recovery: 100, damage: 12, reach: 95, knockback: 260, knockdown: true, heavy: true };
export const AIR_MOVING: AttackSpec = { startup: 110, active: 140, recovery: 90, damage: 10, reach: 100, knockback: 200, knockdown: false };
export const DASH_ATTACK: AttackSpec = { startup: 110, active: 110, recovery: 190, damage: 12, reach: 105, knockback: 320, knockdown: true, heavy: true };
export const DRAGON_CLEAVE: AttackSpec = { startup: 120, active: 200, recovery: 240, damage: 16, reach: 118, knockback: 330, knockdown: true, heavy: true, laneTol: 36, bothSides: true };
export const DRAGON_CLEAVE_HP_COST = 8;
export const PUMMEL_DAMAGE = 5;
export const THROW_VICTIM_DAMAGE = 10; // landing damage to the thrown soldier
export const THROW_BODY_DAMAGE = 14; // damage to each enemy the body hits

export interface KindStats {
  hp: number;
  speed: number;
  depthSpeed: number;
  damage: number;
  reach: number;
  windup: number;
  recovery: number;
  score: number;
  canvasDisplayH: number;
  char: string;
  nameEn: string;
  nameZh: string;
  /** Preferred stand-off distance from the player. */
  preferred: number;
  grabbable: boolean;
}

export const STATS: Record<FighterKind, KindStats> = {
  player: { hp: 100, speed: 232, depthSpeed: 126, damage: 0, reach: 0, windup: 0, recovery: 0, score: 0, canvasDisplayH: 275, char: 'guanyu', nameEn: 'Guan Yu', nameZh: '关羽', preferred: 0, grabbable: false },
  sword: { hp: 26, speed: 130, depthSpeed: 82, damage: 6, reach: 72, windup: 260, recovery: 520, score: 100, canvasDisplayH: 255, char: 'sword', nameEn: 'Sword Soldier', nameZh: '刀兵', preferred: 60, grabbable: true },
  spear: { hp: 32, speed: 94, depthSpeed: 56, damage: 8, reach: 118, windup: 340, recovery: 680, score: 120, canvasDisplayH: 255, char: 'soldier', nameEn: 'Spearman', nameZh: '枪兵', preferred: 90, grabbable: true },
  archer: { hp: 20, speed: 108, depthSpeed: 70, damage: 7, reach: 0, windup: 650, recovery: 900, score: 150, canvasDisplayH: 255, char: 'archer', nameEn: 'Archer', nameZh: '弓兵', preferred: 300, grabbable: true },
  brute: { hp: 80, speed: 62, depthSpeed: 40, damage: 12, reach: 98, windup: 620, recovery: 1150, score: 300, canvasDisplayH: 272, char: 'brute', nameEn: 'Brute', nameZh: '力士', preferred: 78, grabbable: false },
  yujin: { hp: 340, speed: 74, depthSpeed: 44, damage: 9, reach: 110, windup: 420, recovery: 900, score: 1500, canvasDisplayH: 345, char: 'boss', nameEn: 'Yu Jin', nameZh: '于禁', preferred: 96, grabbable: false },
};

// ------------------------------------------------------------------ stage
export interface SpawnDef {
  kind: EnemyKind;
  x: number;
  gy: number;
  /** ms after the wave starts; entries walk in from the deck edges. */
  delay: number;
}
const S = (kind: EnemyKind, x: number, gy: number, delay = 0): SpawnDef => ({ kind, x, gy, delay });

export type PropKind = 'crate' | 'barrel' | 'bun' | 'chicken' | 'feast';
export interface PropDef {
  kind: PropKind;
  x: number;
  gy: number;
  /** Food hidden in a crate. */
  drop?: 'bun' | 'chicken';
}

export interface VariantDef {
  /** Sequential waves inside the locked section. */
  waves: SpawnDef[][];
  props: PropDef[];
}

export interface SectionDef {
  id: string;
  nameEn: string;
  nameZh: string;
  triggerX: number;
  left: number;
  right: number;
  groundTop: number;
  groundBot: number;
  isBoss?: boolean;
  variants: VariantDef[];
}

const MID = 450;
const HI = 425;
const LO = 478;

// Arcade is always variants[0]. Remix picks a seeded variant for decks 2-5
// (indices 1..4); Prow (learning) and Command deck (boss) stay fixed.
export const SECTIONS: SectionDef[] = [
  {
    id: 'prow', nameEn: 'The Prow', nameZh: '船头', triggerX: 360, left: 40, right: 940,
    groundTop: GROUND_TOP, groundBot: GROUND_BOT,
    variants: [{
      waves: [
        [S('sword', 760, MID)],
        [S('sword', 820, HI), S('sword', 860, LO, 700), S('sword', 180, MID, 1500), S('sword', 880, MID, 2300)],
      ],
      props: [
        { kind: 'crate', x: 600, gy: LO, drop: 'bun' },
        { kind: 'crate', x: 300, gy: HI },
      ],
    }],
  },
  {
    id: 'gangplank', nameEn: 'The Gangplank', nameZh: '跳板', triggerX: 1240, left: 1020, right: 1980,
    groundTop: 420, groundBot: 484,
    variants: [
      {
        waves: [
          [S('spear', 1850, 438), S('spear', 1100, 468, 900)],
          [S('spear', 1880, 452), S('spear', 1800, 452, 600), S('sword', 1080, 440, 1100)],
          [S('spear', 1860, 432), S('spear', 1120, 472, 700), S('spear', 1780, 452, 1600), S('sword', 1200, 440, 2300)],
        ],
        props: [{ kind: 'crate', x: 1500, gy: 474, drop: 'bun' }],
      },
      {
        // Remix A: ranks bunch on one lane — a throw clears the file.
        waves: [
          [S('spear', 1840, 452), S('spear', 1740, 452, 500), S('spear', 1640, 452, 1000)],
          [S('sword', 1100, 436), S('spear', 1860, 468, 600), S('sword', 1180, 468, 1200)],
          [S('spear', 1820, 440), S('spear', 1820, 468, 800)],
        ],
        props: [{ kind: 'crate', x: 1400, gy: 430, drop: 'bun' }],
      },
      {
        // Remix B: alternating ends press both sides at once.
        waves: [
          [S('spear', 1860, 468), S('sword', 1090, 438, 400)],
          [S('spear', 1110, 452), S('spear', 1870, 452, 500), S('sword', 1800, 434, 1200)],
          [S('spear', 1850, 436), S('spear', 1130, 470, 600), S('spear', 1760, 452, 1400)],
        ],
        props: [{ kind: 'bun', x: 1500, gy: 452 }],
      },
    ],
  },
  {
    id: 'archer-deck', nameEn: 'Archer Deck', nameZh: '弓兵甲板', triggerX: 2270, left: 2060, right: 3020,
    groundTop: GROUND_TOP, groundBot: GROUND_BOT,
    variants: [
      {
        waves: [
          [S('sword', 2700, HI), S('sword', 2740, LO), S('archer', 2920, MID, 300)],
          [S('spear', 2840, MID), S('spear', 2180, LO, 500), S('archer', 2940, HI, 900), S('sword', 2660, LO, 1500)],
          [S('sword', 2760, MID), S('archer', 2150, HI, 600), S('sword', 2860, LO, 1300)],
        ],
        props: [
          { kind: 'barrel', x: 2820, gy: MID },
          { kind: 'barrel', x: 2400, gy: LO },
          { kind: 'crate', x: 2520, gy: HI, drop: 'bun' },
        ],
      },
      {
        // Remix A: archer behind a shield of soldiers, barrels centre.
        waves: [
          [S('sword', 2680, MID), S('sword', 2760, HI, 300), S('sword', 2760, LO, 600), S('archer', 2930, MID, 400)],
          [S('spear', 2800, HI), S('spear', 2800, LO, 700), S('archer', 2940, LO, 1000)],
        ],
        props: [
          { kind: 'barrel', x: 2580, gy: MID },
          { kind: 'barrel', x: 2640, gy: HI },
          { kind: 'bun', x: 2250, gy: LO },
        ],
      },
      {
        // Remix B: archer enters from the opposite lane after wave one.
        waves: [
          [S('sword', 2720, LO), S('spear', 2840, LO, 400), S('sword', 2200, HI, 800)],
          [S('archer', 2140, LO), S('sword', 2820, MID, 500), S('sword', 2880, HI, 1000), S('archer', 2940, MID, 1600)],
          [S('spear', 2760, MID), S('spear', 2840, MID, 700)],
        ],
        props: [
          { kind: 'barrel', x: 2500, gy: LO },
          { kind: 'crate', x: 2900, gy: HI, drop: 'chicken' },
        ],
      },
    ],
  },
  {
    id: 'burning-deck', nameEn: 'Burning Deck', nameZh: '火船甲板', triggerX: 3310, left: 3100, right: 4060,
    groundTop: GROUND_TOP, groundBot: GROUND_BOT,
    variants: [
      {
        waves: [
          [S('sword', 3680, HI), S('spear', 3800, LO, 400), S('sword', 3220, MID, 900)],
          [S('brute', 3860, MID), S('sword', 3240, HI, 800), S('sword', 3920, LO, 1500)],
        ],
        props: [
          { kind: 'chicken', x: 3450, gy: LO },
          { kind: 'barrel', x: 3960, gy: HI },
          { kind: 'crate', x: 3300, gy: HI },
        ],
      },
      {
        // Remix A: brute arrives late, fire lanes funnel the swords.
        waves: [
          [S('sword', 3720, MID), S('sword', 3800, MID, 500), S('spear', 3900, HI, 1000), S('archer', 3960, LO, 1400)],
          [S('sword', 3260, LO), S('brute', 3880, HI, 900)],
        ],
        props: [
          { kind: 'chicken', x: 3960, gy: LO },
          { kind: 'barrel', x: 3520, gy: MID },
        ],
      },
      {
        // Remix B: pincer entry, barrel by the west entry.
        waves: [
          [S('spear', 3840, HI), S('spear', 3220, LO, 500), S('sword', 3700, MID, 1000)],
          [S('brute', 3300, MID), S('archer', 3940, HI, 800), S('sword', 3840, LO, 1500)],
        ],
        props: [
          { kind: 'barrel', x: 3380, gy: MID },
          { kind: 'chicken', x: 3600, gy: HI },
          { kind: 'crate', x: 3980, gy: LO, drop: 'bun' },
        ],
      },
    ],
  },
  {
    id: 'foredeck', nameEn: 'Flagship Foredeck', nameZh: '旗舰前甲板', triggerX: 4350, left: 4140, right: 5100,
    groundTop: GROUND_TOP, groundBot: GROUND_BOT,
    variants: [
      {
        waves: [
          [S('brute', 4820, HI), S('archer', 4960, LO, 500), S('sword', 4260, MID, 1000)],
          [S('brute', 4880, LO), S('archer', 4980, HI, 600), S('spear', 4280, LO, 1100), S('spear', 4700, MID, 1700)],
        ],
        props: [
          { kind: 'feast', x: 4980, gy: MID },
          { kind: 'barrel', x: 4520, gy: LO },
          { kind: 'crate', x: 4320, gy: HI, drop: 'bun' },
        ],
      },
      {
        // Remix A: archer west, brutes staggered east.
        waves: [
          [S('archer', 4240, HI), S('sword', 4780, MID, 400), S('brute', 4900, LO, 1100)],
          [S('spear', 4800, HI), S('brute', 4250, LO, 700), S('archer', 4970, MID, 1400), S('sword', 4700, LO, 1900)],
        ],
        props: [
          { kind: 'feast', x: 4980, gy: HI },
          { kind: 'barrel', x: 4620, gy: MID },
        ],
      },
      {
        // Remix B: two-archer crossfire behind a spear screen.
        waves: [
          [S('spear', 4760, MID), S('spear', 4840, MID, 500), S('archer', 4960, HI, 800), S('archer', 4260, LO, 1300)],
          [S('brute', 4860, MID), S('brute', 4300, HI, 1200), S('sword', 4680, LO, 1800)],
        ],
        props: [
          { kind: 'feast', x: 4600, gy: LO },
          { kind: 'barrel', x: 4400, gy: MID },
          { kind: 'crate', x: 4960, gy: LO, drop: 'chicken' },
        ],
      },
    ],
  },
  {
    id: 'command-deck', nameEn: 'Command Deck', nameZh: '指挥台', triggerX: 5390, left: 5180, right: 6160,
    groundTop: GROUND_TOP, groundBot: GROUND_BOT, isBoss: true,
    variants: [{
      waves: [[S('yujin', 5920, MID)]],
      props: [{ kind: 'crate', x: 5340, gy: HI, drop: 'chicken' }],
    }],
  },
];

// Fire patches on the Burning Deck (same in every mode; a lane always stays
// reachable between/around them).
export const FIRE_PATCHES = [
  { x: 3520, gy: 432, rx: 85, laneHalf: 20 },
  { x: 3820, gy: 472, rx: 95, laneHalf: 20 },
];
// Falling mast on the Burning Deck: falls across this ground span once.
export const MAST = { triggerX: 3560, x0: 3480, x1: 3860, gy: 452, laneHalf: 27, damage: 30 };

// Yu Jin's 60% reinforcements (spawned once by his flag signal).
export const BOSS_REINFORCEMENTS: SpawnDef[] = [
  S('sword', 5260, HI),
  S('spear', 6080, LO, 400),
];

// ---------------------------------------------------------------- scoring
export const SCORE_EVENTS = {
  throwExtraHit: 150, // per extra enemy struck by one thrown body (throw cap applies)
  throwCapPerThrow: 300,
  barrelMultiHit: 250, // one explosion striking 2+ enemies (once per barrel)
  bossPunish: 200, // first hit of a boss recovery window (encounter cap applies)
  bossPunishCap: 1000,
  timeBonusPerSec: 10, // victory: seconds under par
  timeBonusCap: 1500,
  parTimeSec: 360,
};

// Calibrated against a full clear's score pool (~6200 from defeats alone):
// a careful first clear lands near B, a practiced run with skill bonuses
// reaches A, and a fast high-bonus run is needed for S.
export const RANKS: { rank: string; min: number }[] = [
  { rank: 'S', min: 8800 },
  { rank: 'A', min: 7300 },
  { rank: 'B', min: 5600 },
  { rank: 'C', min: 3800 },
  { rank: 'D', min: 0 },
];

export function rankForScore(score: number): string {
  return RANKS.find((r) => score >= r.min)?.rank ?? 'D';
}

export function nextRankTarget(score: number): { rank: string; need: number } | null {
  const above = [...RANKS].reverse().find((r) => score < r.min);
  return above ? { rank: above.rank, need: above.min - score } : null;
}

export const MEDALS = [
  { id: 'line-breaker', nameEn: 'Line Breaker', nameZh: '破阵', desc: 'Hit two other enemies with one throw' },
  { id: 'deck-tactician', nameEn: 'Deck Tactician', nameZh: '火计', desc: 'Defeat two enemies with one barrel explosion' },
  { id: 'steady-nerve', nameEn: 'Steady Nerve', nameZh: '沉着', desc: 'Defeat Yu Jin without taking damage on the command deck' },
] as const;

// ------------------------------------------------------------- seeded RNG
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Variant index per section for a run. Arcade: all zeros. Remix: decks 2-5
 *  (indices 1..4) are seeded; a run replays identically for the same seed. */
export function pickVariants(mode: 'arcade' | 'remix', seed: number): number[] {
  if (mode === 'arcade') return SECTIONS.map(() => 0);
  const rng = mulberry32(seed * 2654435761);
  return SECTIONS.map((sec, i) => {
    if (i === 0 || i === SECTIONS.length - 1) return 0;
    return Math.floor(rng() * sec.variants.length);
  });
}

export function totalEnemyCount(variantIdx: number[]): number {
  let n = BOSS_REINFORCEMENTS.length;
  SECTIONS.forEach((sec, i) => {
    for (const wave of sec.variants[variantIdx[i]].waves) n += wave.length;
  });
  return n;
}
