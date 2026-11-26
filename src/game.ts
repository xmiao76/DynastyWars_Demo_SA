import Phaser from 'phaser';
import { audio } from './audio';
import {
  AIR_MOVING, AIR_NEUTRAL, AttackSpec, BOSS_REINFORCEMENTS, DASH_ATTACK,
  DEPTH_TOLERANCE, DRAGON_CLEAVE, DRAGON_CLEAVE_HP_COST, EnemyKind, FighterKind,
  FIRE_PATCHES, GROUND_BOT, GROUND_TOP, MAST, MEDALS, PLAYER_COMBO, PropDef,
  PropKind, PUMMEL_DAMAGE, SCORE_EVENTS, SECTIONS, STATS, SectionDef, SpawnDef,
  THROW_BODY_DAMAGE, THROW_VICTIM_DAMAGE, WORLD_W, nextRankTarget, pickVariants,
  rankForScore, totalEnemyCount,
} from './data';
import { MOVE_LIST_LINES, manifests, runConfig, VIEW_H, VIEW_W } from './main';
import { records } from './records';

const GRAVITY = 1500;
const STEP_MS = 1000 / 60;

type FighterState =
  | 'idle' | 'walk' | 'attack' | 'recover' | 'hurt' | 'down' | 'dead'
  | 'grab' | 'grabbed' | 'throw' | 'thrown' | 'dash';

interface DamageOpts {
  heavy?: boolean;
  source?: 'melee' | 'throw' | 'barrel' | 'hazard' | 'arrow' | 'body' | 'test';
  /** Environmental hits can hurt the player through brief hit i-frames. */
  pierceIframes?: boolean;
}

class Fighter {
  kind: FighterKind;
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Ellipse;
  x: number;
  gy: number;
  z = 0;
  vz = 0;
  vx = 0; // knockback / thrown-body velocity
  vy = 0; // depth velocity (thrown bodies)
  facing: 1 | -1 = 1;
  hp: number;
  maxHp: number;
  state: FighterState = 'idle';
  stateT = 0;
  combo = 0;
  comboQueued = false;
  moveId = '';
  spec: AttackSpec | null = null;
  attackHadHit = false;
  hitSet = new Set<Fighter>();
  iframesUntil = 0;
  attackToken = false;
  rangedToken = false;
  thinkT = 0;
  strafeDir = 1;
  atkStrikeAt = 0;
  atkTotal = 0;
  released = false; // archer arrow spawned / throw released for this action
  spawnGraceUntil = 0;
  fireNextAt = 0;
  // grab / throw
  throwHitSet = new Set<Fighter>();
  throwHits = 0;
  throwDirX: 1 | -1 = 1;
  // boss bookkeeping (plain bag to keep pattern code compact)
  d: Record<string, number> = {};
  recentHits: number[] = [];

  constructor(scene: Phaser.Scene, kind: FighterKind, x: number, gy: number) {
    this.kind = kind;
    this.x = x;
    this.gy = gy;
    const st = STATS[kind];
    this.hp = st.hp;
    this.maxHp = st.hp;
    const m = manifests[st.char as keyof typeof manifests];
    const firstKey = scene.textures.exists(`${st.char}-idle-0`) ? `${st.char}-idle-0` : `${st.char}-fallback`;
    this.sprite = scene.add.sprite(x, gy, firstKey);
    const cw = m?.canvas[0] ?? 512;
    const ch = m?.canvas[1] ?? 512;
    this.sprite.setOrigin((m?.originX ?? cw / 2) / cw, (m?.groundY ?? ch * 0.92) / ch);
    this.sprite.setDisplaySize(st.canvasDisplayH * (cw / ch), st.canvasDisplayH);
    this.shadow = scene.add.ellipse(x, gy + 4, 74, 16, 0x000000, 0.35);
    if (kind === 'brute') this.shadow.setSize(92, 19);
    if (kind === 'yujin') this.shadow.setSize(110, 22);
  }

  get alive(): boolean {
    return this.state !== 'dead' && this.hp > 0;
  }
  get airborne(): boolean {
    return this.z > 0;
  }

  syncVisual(): void {
    this.sprite.x = this.x;
    this.sprite.y = this.gy - this.z;
    this.sprite.depth = this.gy + (this.state === 'grabbed' ? 1 : 0);
    this.sprite.flipX = this.facing < 0;
    this.shadow.x = this.x;
    this.shadow.y = this.gy + 4;
    this.shadow.depth = this.gy - 1;
    const shScale = Phaser.Math.Clamp(1 - this.z / 300, 0.45, 1);
    this.shadow.setScale(shScale);
    this.shadow.setAlpha(0.35 * shScale);
  }

  strikeFrac(action = 'attack'): number {
    const m = manifests[STATS[this.kind].char as keyof typeof manifests];
    const f = m?.strikeFrac?.[action];
    if (typeof f === 'number') return f;
    if (this.kind === 'yujin') return 0.62;
    if (this.kind === 'player') return 0.55;
    return 0.68;
  }

  play(action: string, totalMs?: number): void {
    const key = `${STATS[this.kind].char}-${action}`;
    const fallback = `${STATS[this.kind].char}-attack`;
    const use = this.sprite.scene.anims.exists(key) ? key : fallback;
    if (this.sprite.scene.anims.exists(use)) {
      if (this.sprite.anims.currentAnim?.key !== use || totalMs !== undefined) {
        this.sprite.play(use);
      }
      if (totalMs && this.sprite.anims.currentAnim) {
        const base = this.sprite.anims.currentAnim.duration;
        this.sprite.anims.timeScale = base > 0 ? base / totalMs : 1;
      } else if (totalMs === undefined) {
        this.sprite.anims.timeScale = 1;
      }
    }
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}

interface Prop {
  kind: PropKind;
  x: number;
  gy: number;
  hp: number;
  alive: boolean;
  drop?: 'bun' | 'chicken';
  img: Phaser.GameObjects.Image;
  exploding?: boolean;
}

interface Arrow {
  img: Phaser.GameObjects.Image;
  x: number;
  gy: number;
  z: number;
  vx: number;
  alive: boolean;
}

interface Volley {
  x: number;
  gy: number;
  strikeAt: number;
  marker: Phaser.GameObjects.Ellipse;
  struck: boolean;
}

interface SectionRt {
  def: SectionDef;
  variant: number;
  started: boolean;
  cleared: boolean;
  waveIdx: number;
}

interface Snapshot {
  scoreKills: number;
  scoreSkill: number;
  kills: number;
  bestCombo: number;
  medalsRun: string[];
  bossPunishEarned: number;
}

declare global {
  interface Window {
    __DYNASTY__?: unknown;
  }
}

export class GameScene extends Phaser.Scene {
  private player!: Fighter;
  private enemies: Fighter[] = [];
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private sections: SectionRt[] = [];
  private activeSection: SectionRt | null = null;
  private boss: Fighter | null = null;
  private bossIntroUntil = 0;
  private bossPattern: string | null = null;
  private props: Prop[] = [];
  private arrows: Arrow[] = [];
  private volleys: Volley[] = [];
  private pendingSpawns: { at: number; def: SpawnDef }[] = [];
  private pendingExplosions: { at: number; prop: Prop }[] = [];
  private phase: 'intro' | 'playing' | 'paused' | 'won' | 'lost' = 'intro';
  private now = 0; // simulation time (ms), fixed-step
  private accumulator = 0;
  private hitStopMs = 0;
  private startSimTime = 0;
  private endTimeSec = 0;
  // score / run state
  private mode: 'arcade' | 'remix' = 'arcade';
  private seed = 0;
  private variants: number[] = [];
  private scoreKills = 0;
  private scoreSkill = 0;
  private kills = 0;
  private chainHits = 0;
  private chainExpiresAt = 0;
  private bestCombo = 0;
  private medalsRun = new Set<string>();
  private continues = 0;
  private bossPunishEarned = 0;
  private bossPunishWindow = 0; // id of current recovery window (0 = none / used)
  private bossWindowSeq = 0;
  private bossDamagedPlayer = false;
  private checkpoint: Snapshot = { scoreKills: 0, scoreSkill: 0, kills: 0, bestCombo: 0, medalsRun: [], bossPunishEarned: 0 };
  private totalEnemies = 0;
  private lastAttackHitCount = 0;
  private lastHitName = '';
  private lastHitHp = 0;
  private lastHitMax = 1;
  private lastHitUntil = 0;
  // grab
  private grabTarget: Fighter | null = null;
  private grabExpiresAt = 0;
  private pummelCount = 0;
  private pummelReadyAt = 0;
  private resistReadyAt = 0;
  // hazards
  private mastState: 'idle' | 'warning' | 'fallen' = 'idle';
  private mastFallAt = 0;
  private mastVisuals: Phaser.GameObjects.GameObject[] = [];
  private fireVisuals: Phaser.GameObjects.GameObject[] = [];
  // input
  private pendingJAt = 0;
  private pendingKAt = 0;
  private jBufferedAt = 0;
  private lastTapDir = 0;
  private lastTapAt = 0;
  private dashDir: 1 | -1 = 1;
  // HUD
  private hpBar!: Phaser.GameObjects.Rectangle;
  private scoreLabel!: Phaser.GameObjects.Text;
  private sectionLabel!: Phaser.GameObjects.Text;
  private comboLabel!: Phaser.GameObjects.Text;
  private modeLabel!: Phaser.GameObjects.Text;
  private targetLabel!: Phaser.GameObjects.Text;
  private targetBar!: Phaser.GameObjects.Rectangle;
  private goArrow!: Phaser.GameObjects.Text;
  private bossBarWrap!: Phaser.GameObjects.Container;
  private bossBar!: Phaser.GameObjects.Rectangle;
  private overlay: Phaser.GameObjects.Container | null = null;
  private slashFx!: Phaser.GameObjects.Image;
  private slashFx2!: Phaser.GameObjects.Image;
  private aimLine!: Phaser.GameObjects.Rectangle;
  private chargeLane!: Phaser.GameObjects.Rectangle;
  private victoryStats: { total: number; rank: string; timeSec: number; newBest: boolean; timeBonus: number } | null = null;

  constructor() {
    super('game');
  }

  create(): void {
    this.mode = runConfig.mode;
    this.seed = runConfig.seed;
    this.variants = pickVariants(this.mode, this.seed);
    this.enemies = [];
    this.props = [];
    this.arrows = [];
    this.volleys = [];
    this.pendingSpawns = [];
    this.pendingExplosions = [];
    this.boss = null;
    this.activeSection = null;
    this.bossPattern = null;
    this.phase = 'intro';
    this.now = 0;
    this.accumulator = 0;
    this.hitStopMs = 0;
    this.startSimTime = 0;
    this.scoreKills = 0;
    this.scoreSkill = 0;
    this.kills = 0;
    this.chainHits = 0;
    this.bestCombo = 0;
    this.medalsRun = new Set();
    this.continues = 0;
    this.bossPunishEarned = 0;
    this.bossPunishWindow = 0;
    this.bossDamagedPlayer = false;
    this.grabTarget = null;
    this.mastState = 'idle';
    this.mastVisuals = [];
    this.overlay = null;
    this.lastAttackHitCount = 0;
    this.victoryStats = null;
    this.checkpoint = this.makeSnapshot();
    this.totalEnemies = totalEnemyCount(this.variants);
    audio.bossMode = false;

    this.buildPropTextures();
    this.buildBackdrop();
    this.buildFirePatches();

    this.player = new Fighter(this, 'player', 130, 450);
    this.player.facing = 1;
    this.player.play('idle');

    this.sections = SECTIONS.map((def, i) => ({
      def, variant: this.variants[i], started: false, cleared: false, waveIdx: 0,
    }));

    this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_H);
    this.cameras.main.startFollow(this.player.sprite, true, 0.12, 0);
    this.cameras.main.setDeadzone(160, 0);

    this.buildHud();
    this.aimLine = this.add.rectangle(0, 0, 10, 5, 0xffd76a, 0.22).setVisible(false).setDepth(880);
    this.chargeLane = this.add.rectangle(0, 0, 10, 44, 0xc03a28, 0.22).setVisible(false).setDepth(60);

    const kb = this.input.keyboard;
    if (!kb) throw new Error('keyboard unavailable');
    this.cursors = kb.createCursorKeys();
    this.keys = kb.addKeys('W,A,S,D,J,K,M,R,P,C,T') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.on('keydown-J', () => { this.pendingJAt = this.time.now; this.jBufferedAt = this.time.now; });
    kb.on('keydown-K', () => { this.pendingKAt = this.time.now; });
    kb.on('keydown-ESC', () => this.togglePause());
    kb.on('keydown-P', () => this.togglePause());
    kb.on('keydown-M', () => this.toggleMute());
    kb.on('keydown-D', () => this.onDirTap(1));
    kb.on('keydown-RIGHT', () => this.onDirTap(1));
    kb.on('keydown-A', () => this.onDirTap(-1));
    kb.on('keydown-LEFT', () => this.onDirTap(-1));
    kb.on('keydown-R', () => { if (this.phase === 'won' || this.phase === 'lost') this.restartRun(this.mode, this.seed); });
    kb.on('keydown-C', () => { if (this.phase === 'lost') this.doContinue(); });
    kb.on('keydown-T', () => { if (this.phase !== 'playing' && this.phase !== 'intro') this.toTitle(); });
    kb.on('keydown-ENTER', () => {
      if (this.phase === 'lost') this.doContinue();
      else if (this.phase === 'won') this.restartRun('arcade', 0);
    });
    kb.on('keydown-ONE', () => this.resultsChoice(1));
    kb.on('keydown-TWO', () => this.resultsChoice(2));
    kb.on('keydown-THREE', () => this.resultsChoice(3));
    this.game.events.on(Phaser.Core.Events.BLUR, () => {
      if (this.phase === 'playing') this.togglePause();
    });

    this.showBanner('Red Cliffs, 208 AD — the chained fleet burns / 赤壁烽火', 1500);
    this.time.delayedCall(1500, () => {
      if (this.phase === 'intro') {
        this.phase = 'playing';
        this.startSimTime = this.now;
        this.showBanner('Board the fleet!  登船 →', 1300);
      }
    });
    this.exposeTestHooks();
  }

  // ---------------------------------------------------------- setup
  private makeSnapshot(): Snapshot {
    return {
      scoreKills: this.scoreKills, scoreSkill: this.scoreSkill, kills: this.kills,
      bestCombo: this.bestCombo, medalsRun: [...this.medalsRun], bossPunishEarned: this.bossPunishEarned,
    };
  }
  private totalScore(): number {
    return this.scoreKills + this.scoreSkill;
  }

  private buildBackdrop(): void {
    const tile = (key: string, fromX: number, toX: number, depth: number): void => {
      const tex = this.textures.get(key);
      const src = tex.getSourceImage() as { width: number; height: number };
      const dispW = (src.width / Math.max(1, src.height)) * VIEW_H;
      for (let x = fromX; x < toX; x += dispW - 2) {
        const img = this.add.image(x, 0, key).setOrigin(0, 0);
        img.setDisplaySize(dispW, VIEW_H);
        img.depth = depth;
      }
    };
    tile('bg-fleet', 0, 5160, -100);
    tile('bg-flagship', 5160, WORLD_W + 900, -99);
    // Gangplank: a narrow plank bridge over dark water between the hulls.
    // Long horizontal board seams + a darker side face keep it reading as a
    // flat bridge deck, with water visible above and below it.
    const gp = SECTIONS[1];
    const gpW = gp.right - gp.left;
    const deckTop = gp.groundTop - 16;
    const deckBot = gp.groundBot + 20;
    const water = this.add.rectangle(gp.left, deckTop, gpW, VIEW_H - deckTop, 0x0c1c2c, 0.94).setOrigin(0, 0);
    water.depth = -85;
    for (let i = 0; i < 22; i += 1) {
      const glint = this.add.rectangle(gp.left + ((i * 173) % gpW), deckBot + 16 + (i % 3) * 5, 26 + (i % 5) * 9, 2, 0xe88a40, 0.35).setOrigin(0, 0);
      glint.depth = -84;
    }
    // Individual boards with alternating tints, like the painted decks.
    const boardTints = [0x7a5a30, 0x6e4f28, 0x826232, 0x714f28];
    let boardIdx = 0;
    for (let y = deckTop; y < deckBot; y += 14) {
      const board = this.add.rectangle(gp.left, y, gpW, Math.min(14, deckBot - y), boardTints[boardIdx % boardTints.length], 1).setOrigin(0, 0);
      board.depth = -83;
      boardIdx += 1;
      const seam = this.add.rectangle(gp.left, y, gpW, 2, 0x45300f, 0.6).setOrigin(0, 0);
      seam.depth = -82;
    }
    for (let x = gp.left + 30; x < gp.right - 10; x += 92) {
      const joint = this.add.rectangle(x, deckTop + 2, 2, deckBot - deckTop - 4, 0x4a3016, 0.4).setOrigin(0, 0);
      joint.depth = -82;
    }
    const face = this.add.rectangle(gp.left, deckBot, gpW, 10, 0x38220f, 1).setOrigin(0, 0);
    face.depth = -82;
    for (const gyEdge of [deckTop, deckBot - 4]) {
      const rope = this.add.rectangle(gp.left, gyEdge, gpW, 4, 0xc8a86a, 0.95).setOrigin(0, 0);
      rope.depth = -81;
    }
    // Walkable-band shading on the painted decks.
    const lane = this.add.rectangle(0, GROUND_TOP - 22, WORLD_W, VIEW_H - (GROUND_TOP - 22), 0x140a04, 0.12).setOrigin(0, 0);
    lane.depth = -80;
    // Embers drifting over the burning decks (kept sparse, behind fighters).
    const embers = this.add.particles(0, 0, 'spark', {
      x: { min: 0, max: WORLD_W }, y: { min: 120, max: 430 },
      speedY: { min: -26, max: -8 }, speedX: { min: 6, max: 22 },
      lifespan: 2600, quantity: 1, frequency: 260,
      scale: { start: 0.5, end: 0 }, alpha: { start: 0.7, end: 0 },
      tint: [0xffa640, 0xff7030, 0xffd76a],
    });
    embers.setDepth(-50);
  }

  private buildFirePatches(): void {
    this.fireVisuals = [];
    for (const f of FIRE_PATCHES) {
      const scorch = this.add.ellipse(f.x, f.gy, f.rx * 2, f.laneHalf * 2 + 12, 0x1a0c04, 0.8);
      scorch.depth = f.gy - 2;
      const flames = this.add.particles(f.x, f.gy, 'spark', {
        x: { min: -f.rx, max: f.rx }, y: { min: -6, max: 6 },
        speedY: { min: -70, max: -30 }, speedX: { min: -12, max: 12 },
        lifespan: 650, quantity: 2, frequency: 90,
        scale: { start: 1.5, end: 0 }, alpha: { start: 0.9, end: 0 },
        tint: [0xff5a20, 0xffa640, 0xffd76a],
      });
      flames.setDepth(f.gy + 2);
      const warn = this.add.text(f.x, f.gy - 46, '🔥', { fontSize: '18px' }).setOrigin(0.5);
      warn.depth = f.gy + 3;
      this.fireVisuals.push(scorch, flames, warn);
    }
  }

  private buildPropTextures(): void {
    if (!this.textures.exists('slash')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.lineStyle(10, 0xffffff, 0.9);
      g.beginPath(); g.arc(20, 60, 52, Phaser.Math.DegToRad(-70), Phaser.Math.DegToRad(55), false); g.strokePath();
      g.lineStyle(5, 0xbfe8ff, 0.9);
      g.beginPath(); g.arc(20, 60, 40, Phaser.Math.DegToRad(-60), Phaser.Math.DegToRad(45), false); g.strokePath();
      g.generateTexture('slash', 110, 120);
      g.destroy();
    }
    if (!this.textures.exists('spark')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffd76a, 1);
      g.fillCircle(5, 5, 5);
      g.generateTexture('spark', 10, 10);
      g.destroy();
    }
    const tex = (key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void): void => {
      if (this.textures.exists(key)) return;
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      draw(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    tex('prop-crate', 52, 44, (g) => {
      g.fillStyle(0x8a6238, 1); g.fillRect(2, 6, 48, 36);
      g.lineStyle(3, 0x5a3c1c, 1); g.strokeRect(2, 6, 48, 36);
      g.lineBetween(2, 6, 50, 42); g.lineBetween(50, 6, 2, 42);
      g.fillStyle(0xa67a44, 1); g.fillRect(2, 2, 48, 7);
    });
    tex('prop-barrel', 44, 56, (g) => {
      g.fillStyle(0x4a3420, 1); g.fillRoundedRect(4, 4, 36, 50, 9);
      g.lineStyle(3, 0x222222, 1);
      g.lineBetween(5, 16, 39, 16); g.lineBetween(5, 40, 39, 40);
      g.fillStyle(0xd84a20, 1); g.fillCircle(22, 28, 7);
      g.fillStyle(0xffd76a, 1); g.fillCircle(22, 28, 3);
    });
    tex('prop-bun', 36, 28, (g) => {
      g.fillStyle(0xf4ead2, 1); g.fillEllipse(18, 16, 32, 22);
      g.fillStyle(0xdcc9a0, 1); g.fillEllipse(18, 10, 14, 8);
      g.fillStyle(0x7a5c30, 1); g.fillRect(2, 24, 32, 3);
    });
    tex('prop-chicken', 48, 36, (g) => {
      g.fillStyle(0xb06a28, 1); g.fillEllipse(22, 18, 38, 26);
      g.fillStyle(0xd08a38, 1); g.fillEllipse(16, 13, 20, 12);
      g.fillStyle(0xf4ead2, 1); g.fillRect(38, 20, 8, 5);
      g.fillStyle(0x8a4c1c, 1); g.fillRect(2, 30, 44, 4);
    });
    tex('prop-feast', 62, 40, (g) => {
      g.fillStyle(0x7a2c20, 1); g.fillRoundedRect(2, 22, 58, 14, 4);
      g.fillStyle(0xb06a28, 1); g.fillEllipse(20, 18, 30, 20);
      g.fillStyle(0xf4ead2, 1); g.fillEllipse(42, 16, 22, 15);
      g.fillStyle(0x3fae5a, 1); g.fillEllipse(33, 10, 18, 10);
    });
    tex('arrow', 36, 8, (g) => {
      g.lineStyle(3, 0xc8a86a, 1); g.lineBetween(2, 4, 28, 4);
      g.fillStyle(0xd9d9d9, 1); g.fillTriangle(28, 1, 36, 4, 28, 7);
      g.fillStyle(0xc03a28, 1); g.fillTriangle(2, 0, 8, 4, 2, 8);
    });
    this.slashFx = this.add.image(-200, -200, 'slash').setAlpha(0).setDepth(900);
    this.slashFx2 = this.add.image(-200, -200, 'slash').setAlpha(0).setDepth(900);
  }

  private buildHud(): void {
    this.add.rectangle(0, 0, VIEW_W, 56, 0x100c08, 0.72).setOrigin(0, 0).setScrollFactor(0).setDepth(1000);
    this.add.text(16, 7, 'Guan Yu / 关羽', { fontFamily: 'Georgia, serif', fontSize: '17px', color: '#f0d492' }).setScrollFactor(0).setDepth(1001);
    this.add.rectangle(16, 31, 224, 13, 0x3a1512).setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.hpBar = this.add.rectangle(17, 32, 222, 11, 0x3fae5a).setOrigin(0, 0).setScrollFactor(0).setDepth(1002);
    this.targetLabel = this.add.text(250, 9, '', { fontFamily: 'Georgia, serif', fontSize: '14px', color: '#ffb0a0' }).setScrollFactor(0).setDepth(1001);
    this.add.rectangle(250, 33, 150, 8, 0x3a1512).setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.targetBar = this.add.rectangle(251, 34, 0, 6, 0xc03a28).setOrigin(0, 0).setScrollFactor(0).setDepth(1002);
    this.sectionLabel = this.add.text(VIEW_W / 2, 8, '', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e8e0c8' }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1001);
    this.comboLabel = this.add.text(VIEW_W / 2, 30, '', { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#ffd76a' }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1001);
    this.scoreLabel = this.add.text(VIEW_W - 16, 7, 'Score 0', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e8e0c8' }).setOrigin(1, 0).setScrollFactor(0).setDepth(1001);
    this.modeLabel = this.add.text(VIEW_W - 16, 29, this.mode === 'remix' ? `Remix · Seed ${this.seed}` : 'Arcade', { fontSize: '13px', color: '#9a8f74', fontFamily: 'Georgia, serif' }).setOrigin(1, 0).setScrollFactor(0).setDepth(1001);
    this.add.text(12, VIEW_H - 22, 'WASD move · J attack/grab · K jump · J+K 青龙斩 · ×2 tap dash · P pause', { fontSize: '13px', color: '#cbbd96', fontFamily: 'Georgia, serif' }).setScrollFactor(0).setDepth(1001);

    this.bossBarWrap = this.add.container(VIEW_W / 2, VIEW_H - 46).setScrollFactor(0).setDepth(1001).setVisible(false);
    const label = this.add.text(0, -16, 'Yu Jin / 于禁 — Wei General', { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#ffb0a0' }).setOrigin(0.5, 1);
    const bgRect = this.add.rectangle(0, 0, 460, 14, 0x3a1512).setOrigin(0.5);
    this.bossBar = this.add.rectangle(-229, 0, 458, 12, 0xc03a28).setOrigin(0, 0.5);
    this.bossBarWrap.add([label, bgRect, this.bossBar]);

    this.goArrow = this.add.text(VIEW_W - 90, 240, 'GO →', { fontFamily: 'Georgia, serif', fontSize: '34px', color: '#ffd76a', stroke: '#000', strokeThickness: 4 }).setScrollFactor(0).setDepth(1001).setVisible(false);
    this.tweens.add({ targets: this.goArrow, x: VIEW_W - 70, duration: 450, yoyo: true, repeat: -1 });
  }

  private showBanner(text: string, ms: number): void {
    const t = this.add.text(VIEW_W / 2, 118, text, { fontFamily: 'Georgia, serif', fontSize: '27px', color: '#ffd76a', stroke: '#2a1a08', strokeThickness: 5 }).setOrigin(0.5).setScrollFactor(0).setDepth(1500);
    this.tweens.add({ targets: t, alpha: 0, delay: ms, duration: 500, onComplete: () => t.destroy() });
  }

  private floatText(x: number, y: number, text: string, color: string, size = 17): void {
    const label = this.add.text(x, y, text, { fontSize: `${size}px`, color, fontFamily: 'Georgia, serif', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(960);
    this.tweens.add({ targets: label, y: y - 38, alpha: 0, duration: 650, onComplete: () => label.destroy() });
  }

  // ---------------------------------------------------------- input
  private onDirTap(dir: 1 | -1): void {
    const t = this.time.now;
    if (dir === this.lastTapDir && t - this.lastTapAt < 290) {
      this.tryStartDash(dir);
      this.lastTapAt = 0;
    } else {
      this.lastTapDir = dir;
      this.lastTapAt = t;
    }
  }

  /** J/K presses wait ~60ms so a J+K chord resolves to Dragon Cleave before
   *  either single action is consumed. */
  private processPendingInputs(): void {
    const t = this.time.now;
    if (this.pendingJAt && this.pendingKAt && Math.abs(this.pendingJAt - this.pendingKAt) < 120) {
      this.pendingJAt = 0;
      this.pendingKAt = 0;
      this.doDragonCleave();
      return;
    }
    if (this.pendingJAt && t - this.pendingJAt >= 60) {
      this.pendingJAt = 0;
      this.doAttackPress();
    }
    if (this.pendingKAt && t - this.pendingKAt >= 60) {
      this.pendingKAt = 0;
      this.doJumpPress();
    }
  }

  private readMoveInput(): { mx: number; my: number } {
    let mx = 0;
    let my = 0;
    if (this.keys.A.isDown || this.cursors.left.isDown) mx -= 1;
    if (this.keys.D.isDown || this.cursors.right.isDown) mx += 1;
    if (this.keys.W.isDown || this.cursors.up.isDown) my -= 1;
    if (this.keys.S.isDown || this.cursors.down.isDown) my += 1;
    return { mx, my };
  }

  private doAttackPress(): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.hp <= 0) return;
    if (p.state === 'grab') {
      this.grabAction();
      return;
    }
    if (p.state === 'throw' || p.state === 'hurt' || p.state === 'down' || p.state === 'dead') return;
    if (p.state === 'dash') {
      this.startPlayerAttack(DASH_ATTACK, 'dash');
      return;
    }
    if (p.airborne) {
      if (p.state !== 'attack') {
        const { mx } = this.readMoveInput();
        this.startPlayerAttack(mx !== 0 ? AIR_MOVING : AIR_NEUTRAL, 'air');
      }
      return;
    }
    if (p.state === 'attack') {
      if (p.moveId === 'combo' && p.combo < PLAYER_COMBO.length - 1) p.comboQueued = true;
      return;
    }
    // Point-blank grab takes priority over the combo (genre convention).
    const grabbable = this.nearestGrabTarget(true);
    if (grabbable) {
      this.startGrab(grabbable);
      return;
    }
    const heavy = this.nearestGrabTarget(false);
    if (heavy && this.now >= this.resistReadyAt) {
      this.resistReadyAt = this.now + 900;
      p.state = 'recover';
      p.stateT = 0;
      p.d.recoverMs = 220;
      audio.clank();
      this.floatText(heavy.x, heavy.gy - 200, 'Too heavy to throw! / 抓不动', '#ffd76a', 16);
      return;
    }
    p.combo = 0;
    this.startPlayerAttack(PLAYER_COMBO[0], 'combo');
  }

  private nearestGrabTarget(grabbableOnly: boolean): Fighter | null {
    const p = this.player;
    let best: Fighter | null = null;
    let bestDx = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.z > 12) continue;
      if (e.state === 'down' || e.state === 'grabbed' || e.state === 'thrown') continue;
      if (STATS[e.kind].grabbable !== grabbableOnly) continue;
      const dx = (e.x - p.x) * p.facing;
      if (dx < 6 || dx > 66) continue;
      if (Math.abs(e.gy - p.gy) > 24) continue;
      if (dx < bestDx) { bestDx = dx; best = e; }
    }
    return best;
  }

  private startPlayerAttack(spec: AttackSpec, moveId: string): void {
    const p = this.player;
    p.state = 'attack';
    p.stateT = 0;
    p.moveId = moveId;
    p.spec = spec;
    p.hitSet.clear();
    p.comboQueued = false;
    p.attackHadHit = false;
    if (moveId === 'combo' && p.combo === 0) this.lastAttackHitCount = 0;
    const total = spec.startup + spec.active + spec.recovery;
    p.atkStrikeAt = spec.startup;
    p.atkTotal = total;
    p.play('attack', total);
    audio.swing();
    this.showSlash(spec.startup, p.combo === 3 || moveId === 'dash' ? 1.5 : 1.15);
  }

  private showSlash(delayMs: number, scale: number): void {
    const p = this.player;
    this.slashFx.setPosition(p.x + p.facing * 62, p.gy - p.z - 92);
    this.slashFx.setFlipX(p.facing < 0);
    this.slashFx.setDepth(p.gy + 5);
    this.slashFx.setAlpha(0.95);
    this.slashFx.setScale(scale);
    this.tweens.killTweensOf(this.slashFx);
    this.tweens.add({ targets: this.slashFx, alpha: 0, duration: 150, delay: delayMs });
  }

  private doJumpPress(): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.airborne || p.state === 'hurt' || p.state === 'down' || p.state === 'grab' || p.state === 'throw' || p.hp <= 0) return;
    p.vz = 560;
    p.z = 1;
    if (p.state !== 'attack') p.state = 'idle';
    audio.jump();
  }

  private tryStartDash(dir: 1 | -1): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.airborne || p.hp <= 0) return;
    if (p.state !== 'idle' && p.state !== 'walk') return;
    p.state = 'dash';
    p.stateT = 0;
    p.facing = dir;
    this.dashDir = dir;
    p.play('walk');
    p.sprite.anims.timeScale = 2.2;
    audio.swing();
  }

  private doDragonCleave(): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.airborne || p.hp <= 0 || p.state === 'hurt' || p.state === 'down' || p.state === 'grab' || p.state === 'throw') return;
    const spec = DRAGON_CLEAVE;
    const total = spec.startup + spec.active + spec.recovery;
    p.state = 'attack';
    p.stateT = 0;
    p.moveId = 'cleave';
    p.spec = spec;
    p.hitSet.clear();
    p.attackHadHit = false;
    p.released = false; // HP cost not yet paid
    p.atkStrikeAt = spec.startup;
    p.atkTotal = total;
    p.iframesUntil = Math.max(p.iframesUntil, this.now + total);
    p.play('attack', total);
    audio.swing();
    this.time.delayedCall(spec.startup, () => {
      if (!p.sprite.active) return;
      this.showSlash(0, 1.7);
      this.slashFx2.setPosition(p.x - p.facing * 62, p.gy - 92);
      this.slashFx2.setFlipX(p.facing > 0);
      this.slashFx2.setDepth(p.gy + 5);
      this.slashFx2.setAlpha(0.9);
      this.slashFx2.setScale(1.7);
      this.tweens.add({ targets: this.slashFx2, alpha: 0, duration: 200 });
      this.floatText(p.x, p.gy - 215, '青龙斩', '#8affc8', 22);
    });
  }

  // ---------------------------------------------------------- grab/throw
  private gripWorldDx(): number {
    const m = manifests.guanyu;
    if (m?.grip) return (m.grip.dx / m.canvas[0]) * STATS.player.canvasDisplayH * (m.canvas[0] / m.canvas[1]);
    return 62;
  }

  private startGrab(victim: Fighter): void {
    const p = this.player;
    this.grabTarget = victim;
    this.grabExpiresAt = this.now + 2200;
    this.pummelCount = 0;
    this.pummelReadyAt = this.now + 180;
    p.state = 'grab';
    p.stateT = 0;
    victim.state = 'grabbed';
    victim.stateT = 0;
    victim.vx = 0;
    victim.vz = 0;
    this.releaseToken(victim);
    // Hold pose: first throw frame (extended-arm grip from the video clip).
    if (this.textures.exists('guanyu-throw-0')) {
      p.sprite.anims.stop();
      p.sprite.setTexture('guanyu-throw-0');
    } else {
      p.play('idle');
    }
    audio.grab();
  }

  private endGrab(brokeFree: boolean): void {
    const v = this.grabTarget;
    this.grabTarget = null;
    if (v && v.state === 'grabbed') {
      v.state = 'hurt';
      v.stateT = 0;
      v.z = Math.max(0, v.z);
      v.sprite.angle = 0;
    }
    const p = this.player;
    if (p.state === 'grab') {
      p.state = brokeFree ? 'recover' : 'idle';
      p.stateT = 0;
      p.d.recoverMs = 250;
      p.play('idle');
    }
  }

  private grabAction(): void {
    const p = this.player;
    const v = this.grabTarget;
    if (!v) { this.endGrab(false); return; }
    if (this.now < this.pummelReadyAt) return;
    const { mx, my } = this.readMoveInput();
    if ((mx !== 0 || my !== 0) || this.pummelCount >= 3) {
      const dirX = (mx !== 0 ? mx : p.facing) as 1 | -1;
      this.startThrow(dirX, my);
      return;
    }
    this.pummelCount += 1;
    this.pummelReadyAt = this.now + 270;
    audio.hit();
    this.damageFighter(v, p, PUMMEL_DAMAGE, 0, false, { source: 'melee' });
    v.sprite.angle = -14 * p.facing;
  }

  private startThrow(dirX: 1 | -1, dirY: number): void {
    const p = this.player;
    const v = this.grabTarget;
    if (!v) return;
    p.facing = dirX;
    p.state = 'throw';
    p.stateT = 0;
    p.released = false;
    p.d.throwDirY = dirY;
    const total = 560;
    p.atkTotal = total;
    p.atkStrikeAt = Math.round(total * p.strikeFrac('throw'));
    // Reuse the grab slot to keep pinning the victim until the release tick.
    p.play('throw', total);
  }

  private releaseThrownVictim(): void {
    const p = this.player;
    const v = this.grabTarget;
    if (!v) return;
    this.grabTarget = null;
    v.state = 'thrown';
    v.stateT = 0;
    v.throwDirX = p.facing;
    v.vx = p.facing * 545;
    v.vy = (p.d.throwDirY ?? 0) * 130;
    v.vz = 330;
    v.z = Math.max(v.z, 16);
    v.throwHitSet.clear();
    v.throwHits = 0;
    v.facing = (-p.facing) as 1 | -1;
    audio.throwWhoosh();
  }

  private pinGrabbed(): void {
    const p = this.player;
    const v = this.grabTarget;
    if (!v) return;
    v.x = p.x + p.facing * this.gripWorldDx();
    v.gy = p.gy;
    v.z = 14;
    v.facing = (-p.facing) as 1 | -1;
    if (v.sprite.angle === 0) v.sprite.angle = -10 * p.facing;
  }

  // ---------------------------------------------------------- combat core
  private inHitRange(att: Fighter, def: Fighter, spec: AttackSpec): boolean {
    const tol = spec.laneTol ?? DEPTH_TOLERANCE;
    if (Math.abs(def.gy - att.gy) > tol) return false;
    const dx = spec.bothSides ? Math.abs(def.x - att.x) : (def.x - att.x) * att.facing;
    if (spec.bothSides) {
      if (dx > spec.reach + 26) return false;
    } else if (dx < -18 || dx > spec.reach + 26) return false;
    if (!att.airborne && def.z > 85) return false;
    if (def.state === 'grabbed' || def.state === 'dead') return false;
    return true;
  }

  private isArmored(def: Fighter): boolean {
    if (def.kind !== 'brute' && def.kind !== 'yujin') return false;
    if (def.kind === 'brute') return def.state === 'attack' && def.stateT <= def.atkStrikeAt + 130;
    // Yu Jin: armored through pattern wind-ups / charge / leap.
    return def.state === 'attack' && def.stateT <= def.atkStrikeAt + 130
      || (this.bossPattern !== null && ['charge', 'leap', 'burst'].includes(this.bossPattern));
  }

  private damageFighter(def: Fighter, att: Fighter | null, dmg: number, knockback: number, knockdown: boolean, opts: DamageOpts = {}): boolean {
    if (def.state === 'dead' || def.hp <= 0) return false;
    if (def.state === 'grabbed' && att !== this.player) return false;
    if (def.kind === 'player' && att && this.now < def.iframesUntil && !opts.pierceIframes) return false;
    const armored = this.isArmored(def) && !opts.heavy && opts.source !== 'barrel' && opts.source !== 'body';
    def.hp = Math.max(0, def.hp - dmg);
    const dir = att ? (def.x >= att.x ? 1 : -1) : 0;
    def.vx = dir * knockback * (armored ? 0.12 : 1);
    this.spawnHitFx(def.x, def.gy - def.z - 100, dmg);
    const byPlayer = att?.kind === 'player' || opts.source === 'body' || opts.source === 'barrel';

    if (def.kind === 'player') {
      audio.hurt();
      def.iframesUntil = this.now + 900;
      this.cameras.main.shake(90, 0.004);
      this.chainHits = 0;
      if (this.activeSection?.def.isBoss) this.bossDamagedPlayer = true;
      if (this.grabTarget) this.endGrab(true);
      if (def.hp <= 0) {
        def.state = 'down';
        def.stateT = 0;
        this.onPlayerDefeated();
      } else {
        def.state = knockdown ? 'down' : 'hurt';
        def.stateT = 0;
        if (knockdown) { def.vz = 260; def.z = Math.max(def.z, 1); }
      }
    } else {
      if (byPlayer) {
        this.lastAttackHitCount += 1;
        this.chainHits += 1;
        this.chainExpiresAt = this.now + 1400;
        this.bestCombo = Math.max(this.bestCombo, this.chainHits);
        this.lastHitName = `${STATS[def.kind].nameEn} / ${STATS[def.kind].nameZh}`;
        this.lastHitHp = def.hp;
        this.lastHitMax = def.maxHp;
        this.lastHitUntil = this.now + 2600;
        if (att?.kind === 'player' && att.spec) att.attackHadHit = true;
        // Clean boss punish: first player hit inside a fresh recovery window.
        if (def.kind === 'yujin' && this.bossPunishWindow > 0 && att?.kind === 'player') {
          this.bossPunishWindow = 0;
          if (this.bossPunishEarned < SCORE_EVENTS.bossPunishCap) {
            this.bossPunishEarned += SCORE_EVENTS.bossPunish;
            this.scoreSkill += SCORE_EVENTS.bossPunish;
            this.floatText(def.x, def.gy - 230, `PUNISH +${SCORE_EVENTS.bossPunish}`, '#ffd76a', 16);
          }
        }
      }
      audio.hit();
      this.hitStopMs = Math.max(this.hitStopMs, opts.heavy ? 55 : 36);
      if (def.hp <= 0) {
        const wasThrown = def.state === 'thrown';
        void wasThrown;
        def.state = 'down';
        def.stateT = 0;
        this.releaseToken(def);
        audio.death();
        this.kills += 1;
        this.scoreKills += STATS[def.kind].score;
        if (this.grabTarget === def) { this.grabTarget = null; this.player.state = 'idle'; this.player.play('idle'); }
        if (def.kind === 'yujin') this.onBossDefeated();
      } else if (armored) {
        audio.clank();
        this.floatText(def.x, def.gy - def.z - 190, 'ARMORED', '#cfd8e6', 13);
      } else if (def.kind === 'yujin') {
        // Boss flinches in approach; tallies hits for the guard burst.
        def.recentHits.push(this.now);
        def.recentHits = def.recentHits.filter((t) => this.now - t < 1200);
        if (!this.bossPattern) {
          def.state = 'hurt';
          def.stateT = 0;
          def.d.hurtMs = opts.heavy ? 320 : 190;
          this.releaseToken(def);
        }
      } else {
        if (def.state === 'grabbed') {
          // Pummel: victim stays held.
        } else {
          def.state = knockdown ? 'down' : 'hurt';
          def.stateT = 0;
          if (knockdown) { def.vz = 240; def.z = Math.max(def.z, 1); }
          this.releaseToken(def);
        }
      }
    }
    def.sprite.setTintFill(0xffffff);
    this.time.delayedCall(70, () => {
      if (def.sprite.active) def.sprite.clearTint();
    });
    return true;
  }

  private spawnHitFx(x: number, y: number, dmg: number): void {
    const particles = this.add.particles(x, y, 'spark', {
      speed: { min: 60, max: 240 }, lifespan: 240, quantity: 7,
      scale: { start: 1, end: 0 }, emitting: false,
    });
    particles.setDepth(950);
    particles.explode(7);
    this.time.delayedCall(350, () => particles.destroy());
    this.floatText(x, y - 18, `${dmg}`, '#ffe9a8');
  }

  // Attack budgets: at most 2 melee + 1 ranged attackers at once (boss and
  // his reinforcements share the same budgets).
  private tokensInUse(): number {
    return this.enemies.filter((e) => e.attackToken).length;
  }
  private tryTakeToken(e: Fighter): boolean {
    if (e.attackToken) return true;
    if (this.player.hp <= 0 || this.player.state === 'down') return false;
    if (this.now < e.spawnGraceUntil) return false;
    if (this.tokensInUse() >= 2) return false;
    e.attackToken = true;
    return true;
  }
  private tryTakeRanged(e: Fighter): boolean {
    if (e.rangedToken) return true;
    if (this.player.hp <= 0 || this.player.state === 'down') return false;
    if (this.now < e.spawnGraceUntil) return false;
    if (this.enemies.some((o) => o.rangedToken)) return false;
    e.rangedToken = true;
    return true;
  }
  private releaseToken(e: Fighter): void {
    e.attackToken = false;
    e.rangedToken = false;
  }

  // ---------------------------------------------------------- main loop
  update(_time: number, deltaMs: number): void {
    this.processPendingInputs();
    if (this.phase === 'paused') return;
    if (this.hitStopMs > 0) {
      this.hitStopMs -= deltaMs;
      return;
    }
    this.accumulator += Math.min(deltaMs, 100);
    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < 4) {
      this.accumulator -= STEP_MS;
      steps += 1;
      this.step(STEP_MS / 1000);
      if (this.hitStopMs > 0) break;
    }
    if (steps === 4) this.accumulator = 0;
    this.updateHud();
  }

  private step(dt: number): void {
    this.now += dt * 1000;
    if (this.phase === 'playing') {
      this.updatePlayer(dt);
      this.updateSections(dt);
      for (const e of [...this.enemies]) this.updateEnemy(e, dt);
      this.updateArrows(dt);
      this.updateVolleys(dt);
      this.updateHazards(dt);
      this.updateProps();
      this.separateFighters(dt);
    }
    for (const f of [this.player, ...this.enemies]) this.applyPhysics(f, dt);
    this.pinGrabbed();
    for (const f of [this.player, ...this.enemies]) f.syncVisual();
    this.enemies = this.enemies.filter((e) => e.sprite.active);
    if (this.chainHits > 0 && this.now > this.chainExpiresAt) this.chainHits = 0;
  }

  private groundBandAt(x: number): { top: number; bot: number } {
    for (const sec of SECTIONS) {
      if (x >= sec.left - 50 && x <= sec.right + 50) return { top: sec.groundTop, bot: sec.groundBot };
    }
    return { top: GROUND_TOP, bot: GROUND_BOT };
  }

  private applyPhysics(f: Fighter, dt: number): void {
    if (f.z > 0 || f.vz > 0) {
      f.z += f.vz * dt;
      f.vz -= GRAVITY * dt;
      if (f.z <= 0) {
        f.z = 0;
        f.vz = 0;
        if (f.state === 'thrown') this.landThrownBody(f);
        if (f.kind === 'yujin' && this.bossPattern === 'leap') this.bossLeapLand();
      }
    }
    if (f.state === 'thrown') {
      f.x += f.vx * dt;
      f.gy += f.vy * dt;
      f.sprite.angle += 520 * dt * f.throwDirX;
      this.thrownBodyCollisions(f);
    } else if (Math.abs(f.vx) > 1) {
      f.x += f.vx * dt;
      f.vx = Phaser.Math.Linear(f.vx, 0, Math.min(1, dt * 7));
    }
    const bounds = this.movementBounds(f);
    f.x = Phaser.Math.Clamp(f.x, bounds.left, bounds.right);
    const band = this.groundBandAt(f.x);
    f.gy = Phaser.Math.Clamp(f.gy, band.top, band.bot);
    if (f.state !== 'thrown' && f.state !== 'grabbed') {
      const targetAngle = f.state === 'down' && f.z === 0 ? -78 * f.facing : 0;
      f.sprite.angle = Phaser.Math.Linear(f.sprite.angle, targetAngle, 0.25);
    }
  }

  private landThrownBody(v: Fighter): void {
    v.sprite.angle = 0;
    v.vx = 0;
    v.vy = 0;
    if (v.throwHits >= 2) this.awardMedal('line-breaker');
    const killed = v.hp <= THROW_VICTIM_DAMAGE;
    this.damageFighter(v, this.player, THROW_VICTIM_DAMAGE, 0, true, { heavy: true, source: 'throw' });
    if (!killed && v.hp > 0) {
      v.state = 'down';
      v.stateT = 0;
    }
  }

  private thrownBodyCollisions(v: Fighter): void {
    for (const e of this.enemies) {
      if (e === v || !e.alive || e.state === 'down' || e.state === 'grabbed') continue;
      if (v.throwHitSet.has(e)) continue;
      if (Math.abs(e.x - v.x) < 46 && Math.abs(e.gy - v.gy) < 28 && e.z < 90) {
        v.throwHitSet.add(e);
        v.throwHits += 1;
        const bonus = Math.min(SCORE_EVENTS.throwExtraHit, SCORE_EVENTS.throwCapPerThrow);
        this.scoreSkill += v.throwHits * SCORE_EVENTS.throwExtraHit <= SCORE_EVENTS.throwCapPerThrow ? bonus : 0;
        this.damageFighter(e, this.player, THROW_BODY_DAMAGE, 300 * v.throwDirX, true, { heavy: true, source: 'body' });
        if (v.throwHits >= 2) this.floatText(e.x, e.gy - 210, 'LINE BREAKER!', '#ffd76a', 18);
      }
    }
  }

  private movementBounds(f: Fighter): { left: number; right: number } {
    if (this.activeSection) {
      return { left: this.activeSection.def.left + 16, right: this.activeSection.def.right - 16 };
    }
    if (f.kind === 'player') {
      const next = this.sections.find((s) => !s.cleared);
      if (next) return { left: 30, right: next.def.right - 24 };
    }
    return { left: 30, right: WORLD_W - 30 };
  }

  private separateFighters(dt: number): void {
    const all = this.enemies.filter((e) => e.alive && e.state !== 'grabbed' && e.state !== 'thrown');
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        const dx = b.x - a.x;
        if (Math.abs(dx) < 34 && Math.abs(b.gy - a.gy) < 18) {
          const push = (dx >= 0 ? 1 : -1) * 26 * dt;
          a.x -= push;
          b.x += push;
        }
      }
    }
  }

  // ---------------------------------------------------------- player
  private updatePlayer(dt: number): void {
    const p = this.player;
    if (!p.alive && p.state !== 'down') return;
    p.stateT += dt * 1000;
    const st = STATS.player;

    if (this.now < p.iframesUntil) {
      p.sprite.setAlpha(Math.sin(this.now / 35) > 0 ? 0.45 : 0.95);
    } else if (p.sprite.alpha !== 1) {
      p.sprite.setAlpha(1);
    }

    if (p.state === 'grab') {
      if (!this.grabTarget || this.grabTarget.hp <= 0) { this.endGrab(false); return; }
      if (this.now >= this.grabExpiresAt) { this.endGrab(true); return; }
      return;
    }

    if (p.state === 'throw') {
      if (!p.released && p.stateT >= p.atkStrikeAt) {
        p.released = true;
        this.releaseThrownVictim();
      }
      if (p.stateT >= p.atkTotal) {
        if (this.grabTarget) this.releaseThrownVictim(); // safety
        p.state = 'idle';
        p.play('idle');
      }
      return;
    }

    if (p.state === 'dash') {
      p.x += this.dashDir * 630 * dt;
      if (p.stateT >= 200) {
        p.state = 'idle';
        p.sprite.anims.timeScale = 1;
      }
      return;
    }

    if (p.state === 'attack') {
      const spec = p.spec ?? PLAYER_COMBO[0];
      const t = p.stateT;
      if (t >= spec.startup && t < spec.startup + spec.active) {
        const lunge = p.moveId === 'dash' ? 330 : p.moveId === 'cleave' ? 30 : 55;
        if (!p.airborne) p.x += p.facing * lunge * dt;
        for (const e of this.enemies) {
          if (e.hp > 0 && !p.hitSet.has(e) && this.inHitRange(p, e, spec)) {
            p.hitSet.add(e);
            this.damageFighter(e, p, spec.damage, spec.knockback, spec.knockdown, { heavy: spec.heavy, source: 'melee' });
            if (p.moveId === 'cleave' && !p.released) {
              p.released = true;
              const cost = Math.min(DRAGON_CLEAVE_HP_COST, Math.max(0, p.hp - 1));
              if (cost > 0) {
                p.hp -= cost;
                this.floatText(p.x, p.gy - 200, `-${cost} HP`, '#ff9a8a', 15);
              }
            }
          }
        }
        this.attackProps(p, spec);
      }
      if (t >= p.atkTotal) {
        if (p.moveId === 'combo' && p.comboQueued && p.attackHadHit && p.combo < PLAYER_COMBO.length - 1 && !p.airborne) {
          p.combo += 1;
          this.startPlayerAttack(PLAYER_COMBO[p.combo], 'combo');
        } else {
          const wasCombo = p.moveId === 'combo';
          p.state = 'idle';
          p.combo = 0;
          p.spec = null;
          // Brief input buffer: a J tapped just before recovery ends starts
          // the next chain from the top instead of being swallowed.
          if (wasCombo && !p.airborne && this.time.now - this.jBufferedAt < 190 && this.time.now - this.jBufferedAt > 60) {
            this.jBufferedAt = 0;
            this.doAttackPress();
          }
        }
      }
      return;
    }

    if (p.state === 'recover') {
      if (p.stateT > (p.d.recoverMs ?? 250)) { p.state = 'idle'; p.play('idle'); }
      return;
    }
    if (p.state === 'hurt') {
      if (p.stateT > 240) p.state = 'idle';
      return;
    }
    if (p.state === 'down') {
      if (p.hp > 0 && p.stateT > 780 && p.z === 0) {
        p.state = 'idle';
        p.iframesUntil = this.now + 800; // wake-up protection
      }
      return;
    }

    const { mx, my } = this.readMoveInput();
    if (mx !== 0) p.facing = mx as 1 | -1;
    p.x += mx * st.speed * dt;
    p.gy += my * st.depthSpeed * dt;
    if (mx !== 0 || my !== 0) {
      p.state = 'walk';
      p.play(p.airborne ? 'idle' : 'walk');
    } else {
      p.state = 'idle';
      p.play('idle');
    }
  }

  // ---------------------------------------------------------- sections
  private updateSections(dt: number): void {
    void dt;
    // Pending wave entries.
    const due = this.pendingSpawns.filter((s) => this.now >= s.at);
    this.pendingSpawns = this.pendingSpawns.filter((s) => this.now < s.at);
    for (const s of due) this.spawnEnemy(s.def.kind, s.def.x, s.def.gy);
    const dueBoom = this.pendingExplosions.filter((s) => this.now >= s.at);
    this.pendingExplosions = this.pendingExplosions.filter((s) => this.now < s.at);
    for (const b of dueBoom) if (b.prop.alive) this.explodeBarrel(b.prop);

    const p = this.player;
    if (!this.activeSection) {
      const next = this.sections.find((s) => !s.cleared && !s.started);
      if (next && p.x >= next.def.triggerX) this.startSection(next);
      return;
    }
    const sec = this.activeSection;
    const remaining = this.enemies.some((e) => e.hp > 0) || this.pendingSpawns.length > 0;
    if (remaining) return;
    const variant = sec.def.variants[sec.variant];
    if (sec.waveIdx < variant.waves.length - 1) {
      sec.waveIdx += 1;
      this.spawnWave(sec);
      return;
    }
    // Section cleared.
    sec.cleared = true;
    this.activeSection = null;
    this.checkpoint = this.makeSnapshot();
    this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_H);
    this.clearArrows();
    if (!sec.def.isBoss) {
      this.goArrow.setVisible(true);
      this.showBanner(`${sec.def.nameEn} clear!`, 1100);
      this.time.delayedCall(1700, () => this.goArrow.setVisible(false));
    }
  }

  private startSection(sec: SectionRt): void {
    sec.started = true;
    sec.waveIdx = 0;
    this.activeSection = sec;
    this.cameras.main.setBounds(sec.def.left, 0, sec.def.right - sec.def.left, VIEW_H);
    // Props for this attempt (rebuilt on continue as well).
    this.destroySectionProps(sec);
    const variant = sec.def.variants[sec.variant];
    for (const pd of variant.props) this.spawnProp(pd, sec);
    if (sec.def.id === 'burning-deck' && this.mastState === 'fallen') {
      this.resetMast();
    }
    if (sec.def.isBoss) {
      this.bossDamagedPlayer = false;
      this.bossIntroUntil = this.now + 1600;
      this.bossBarWrap.setVisible(true);
      audio.bossMode = true;
      audio.slam();
      this.showBanner('Yu Jin / 于禁 — Hold the command deck!', 2000);
    } else {
      this.showBanner(`${sec.def.nameEn} / ${sec.def.nameZh}`, 1300);
    }
    this.spawnWave(sec);
  }

  private spawnWave(sec: SectionRt): void {
    const variant = sec.def.variants[sec.variant];
    const wave = variant.waves[sec.waveIdx] ?? [];
    for (const s of wave) {
      if (s.delay <= 0) this.spawnEnemy(s.kind, s.x, s.gy);
      else this.pendingSpawns.push({ at: this.now + s.delay, def: s });
    }
    if (sec.waveIdx > 0) this.showBanner('Reinforcements!', 900);
  }

  private spawnEnemy(kind: EnemyKind, x: number, gy: number): Fighter {
    const e = new Fighter(this, kind, x, gy);
    e.facing = this.player.x >= x ? 1 : -1;
    e.spawnGraceUntil = this.now + 700;
    e.play('walk');
    e.sprite.setAlpha(0);
    this.tweens.add({ targets: e.sprite, alpha: 1, duration: 300 });
    this.enemies.push(e);
    if (kind === 'yujin') {
      this.boss = e;
      e.d.phase = 1;
      e.d.signaled = 0;
      e.d.burstReadyAt = 0;
    }
    return e;
  }

  // ---------------------------------------------------------- props & food
  private healOf(kind: PropKind): number {
    return kind === 'bun' ? 18 : kind === 'chicken' ? 35 : kind === 'feast' ? 50 : 0;
  }

  private spawnProp(pd: PropDef, sec: SectionRt | null): Prop {
    const img = this.add.image(pd.x, pd.gy, `prop-${pd.kind}`).setOrigin(0.5, 1);
    img.depth = pd.gy - 1;
    const prop: Prop = {
      kind: pd.kind, x: pd.x, gy: pd.gy, alive: true,
      hp: pd.kind === 'crate' ? 14 : pd.kind === 'barrel' ? 10 : 999,
      drop: pd.drop, img,
    };
    (prop as Prop & { sectionId?: string }).sectionId = sec?.def.id;
    this.props.push(prop);
    return prop;
  }

  private destroySectionProps(sec: SectionRt): void {
    for (const prop of this.props) {
      if ((prop as Prop & { sectionId?: string }).sectionId === sec.def.id && prop.alive) {
        prop.alive = false;
        prop.img.destroy();
      }
    }
    this.props = this.props.filter((p) => p.alive);
  }

  private attackProps(att: Fighter, spec: AttackSpec): void {
    for (const prop of this.props) {
      if (!prop.alive || this.healOf(prop.kind) > 0) continue;
      const dx = (prop.x - att.x) * att.facing;
      if ((dx < -10 || dx > spec.reach + 20) && !spec.bothSides) continue;
      if (spec.bothSides && Math.abs(prop.x - att.x) > spec.reach + 20) continue;
      if (Math.abs(prop.gy - att.gy) > DEPTH_TOLERANCE + 6) continue;
      if (att.hitSet.has(prop as unknown as Fighter)) continue;
      att.hitSet.add(prop as unknown as Fighter);
      prop.hp -= spec.damage;
      this.spawnHitFx(prop.x, prop.gy - 30, spec.damage);
      if (prop.hp <= 0) {
        if (prop.kind === 'barrel') this.explodeBarrel(prop);
        else this.breakCrate(prop);
      }
    }
  }

  private breakCrate(prop: Prop): void {
    prop.alive = false;
    audio.hit();
    const particles = this.add.particles(prop.x, prop.gy - 20, 'spark', {
      speed: { min: 40, max: 160 }, lifespan: 300, quantity: 8,
      tint: [0xa67a44, 0x6b4a2a], scale: { start: 1.2, end: 0 }, emitting: false,
    });
    particles.setDepth(950);
    particles.explode(8);
    this.time.delayedCall(400, () => particles.destroy());
    prop.img.destroy();
    if (prop.drop) {
      this.spawnProp({ kind: prop.drop, x: prop.x, gy: prop.gy }, this.activeSection);
    }
  }

  private explodeBarrel(prop: Prop): void {
    if (!prop.alive || prop.exploding) return;
    prop.exploding = true;
    prop.alive = false;
    prop.img.destroy();
    audio.explosion();
    this.cameras.main.shake(200, 0.008);
    this.hitStopMs = Math.max(this.hitStopMs, 70);
    const boom = this.add.particles(prop.x, prop.gy - 26, 'spark', {
      speed: { min: 80, max: 380 }, lifespan: 480, quantity: 26,
      tint: [0xff5a20, 0xffa640, 0xffd76a], scale: { start: 2.2, end: 0 }, emitting: false,
    });
    boom.setDepth(960);
    boom.explode(26);
    this.time.delayedCall(600, () => boom.destroy());
    const R = 128;
    // Track medal (kills by THIS explosion) and skill bonus (multi-hit).
    const before = new Map<Fighter, number>();
    for (const e of this.enemies) before.set(e, e.hp);
    let hits = 0;
    for (const e of [...this.enemies]) {
      if (!e.alive || e.state === 'grabbed') continue;
      if (Math.abs(e.x - prop.x) <= R && Math.abs(e.gy - prop.gy) <= 44 && e.z < 95) {
        hits += 1;
        this.damageFighter(e, this.player, 26, 330, true, { heavy: true, source: 'barrel' });
      }
    }
    let explosionKills = 0;
    for (const [e, hp] of before) if (hp > 0 && e.hp <= 0) explosionKills += 1;
    if (hits >= 2) {
      this.scoreSkill += SCORE_EVENTS.barrelMultiHit;
      this.floatText(prop.x, prop.gy - 120, `BARREL ×${hits} +${SCORE_EVENTS.barrelMultiHit}`, '#ffd76a', 16);
    }
    if (explosionKills >= 2) this.awardMedal('deck-tactician');
    // Explosions hurt Guan Yu too.
    const p = this.player;
    if (p.hp > 0 && Math.abs(p.x - prop.x) <= R && Math.abs(p.gy - prop.gy) <= 44 && p.z < 95) {
      // Attacker-less damage: direction from the barrel, i-frames respected
      // only when an attacker exists, so nudge the player away manually.
      const dir = p.x >= prop.x ? 1 : -1;
      if (this.damageFighter(p, null, 12, 0, true, { heavy: true, source: 'barrel' })) p.vx = dir * 260;
    }
    // Chain nearby barrels.
    for (const other of this.props) {
      if (other.alive && other.kind === 'barrel' && Math.abs(other.x - prop.x) <= R + 30 && Math.abs(other.gy - prop.gy) <= 50) {
        this.pendingExplosions.push({ at: this.now + 140, prop: other });
      }
    }
  }

  private updateProps(): void {
    const p = this.player;
    for (const prop of this.props) {
      if (!prop.alive) continue;
      const heal = this.healOf(prop.kind);
      if (heal <= 0) continue;
      // Food is only picked up when hurt, so a visible heal can be saved.
      if (p.hp > 0 && p.hp < p.maxHp && p.z < 20 && Math.abs(p.x - prop.x) < 36 && Math.abs(p.gy - prop.gy) < 24) {
        prop.alive = false;
        prop.img.destroy();
        p.hp = Math.min(p.maxHp, p.hp + heal);
        audio.pickup();
        const names: Record<string, string> = { bun: 'Steamed bun / 馒头', chicken: 'Roast chicken / 烧鸡', feast: 'Captain’s feast / 酒席' };
        this.floatText(p.x, p.gy - 195, `${names[prop.kind]} +${heal}`, '#8aff9a', 16);
      }
    }
    this.props = this.props.filter((pr) => pr.alive || pr.img.active);
  }

  // ---------------------------------------------------------- hazards
  private updateHazards(dt: number): void {
    void dt;
    // Fire patches burn anyone standing in them (one lane always stays safe).
    for (const f of [this.player, ...this.enemies]) {
      if (f.hp <= 0 || f.z > 24 || f.state === 'dead' || f.state === 'grabbed' || f.state === 'thrown') continue;
      for (const patch of FIRE_PATCHES) {
        if (Math.abs(f.x - patch.x) <= patch.rx && Math.abs(f.gy - patch.gy) <= patch.laneHalf) {
          if (this.now >= f.fireNextAt) {
            f.fireNextAt = this.now + 550;
            if (f.kind === 'player') {
              this.damageFighter(f, this.boss ?? f, 5, 0, false, { source: 'hazard' });
            } else {
              this.damageFighter(f, this.player, 6, 0, false, { heavy: true, source: 'hazard' });
            }
          }
        }
      }
    }
    // Falling mast: readable shadow + creak, then one heavy fall.
    const burning = this.activeSection?.def.id === 'burning-deck';
    if (this.mastState === 'idle' && burning && this.player.x >= MAST.triggerX) {
      this.mastState = 'warning';
      this.mastFallAt = this.now + 950;
      audio.creak();
      const shadow = this.add.ellipse((MAST.x0 + MAST.x1) / 2, MAST.gy, MAST.x1 - MAST.x0, MAST.laneHalf * 2, 0x000000, 0.45);
      shadow.depth = MAST.gy - 1;
      const band = this.add.rectangle(MAST.x0, MAST.gy - MAST.laneHalf, MAST.x1 - MAST.x0, MAST.laneHalf * 2, 0xc03a28, 0.18).setOrigin(0, 0);
      band.depth = MAST.gy - 2;
      const warn = this.add.text((MAST.x0 + MAST.x1) / 2, MAST.gy - 120, '⚠ 桅杆!', { fontSize: '22px', color: '#ffd76a', fontFamily: 'Georgia, serif', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
      warn.depth = 900;
      this.mastVisuals.push(shadow, band, warn);
      this.tweens.add({ targets: shadow, scaleX: 1.04, scaleY: 1.3, duration: 950 });
    } else if (this.mastState === 'warning' && this.now >= this.mastFallAt) {
      this.mastState = 'fallen';
      audio.slam();
      audio.explosion();
      this.cameras.main.shake(240, 0.009);
      for (const v of this.mastVisuals) v.destroy();
      this.mastVisuals = [];
      const beam = this.add.rectangle((MAST.x0 + MAST.x1) / 2, MAST.gy, MAST.x1 - MAST.x0, 15, 0x4a2f16, 1);
      beam.depth = MAST.gy;
      beam.angle = 2;
      this.mastVisuals.push(beam);
      for (const f of [this.player, ...this.enemies]) {
        if (f.hp <= 0 || f.z > 30 || f.state === 'grabbed' || f.state === 'thrown') continue;
        if (f.x >= MAST.x0 && f.x <= MAST.x1 && Math.abs(f.gy - MAST.gy) <= MAST.laneHalf) {
          if (f.kind === 'player') this.damageFighter(f, this.boss ?? f, 16, 200, true, { heavy: true, source: 'hazard' });
          else this.damageFighter(f, this.player, MAST.damage, 200, true, { heavy: true, source: 'hazard' });
        }
      }
    }
  }

  private resetMast(): void {
    this.mastState = 'idle';
    for (const v of this.mastVisuals) v.destroy();
    this.mastVisuals = [];
  }

  // ---------------------------------------------------------- projectiles
  private fireArrow(from: Fighter): void {
    const img = this.add.image(from.x + from.facing * 46, from.gy - 96, 'arrow');
    img.setFlipX(from.facing < 0);
    img.depth = from.gy + 4;
    this.arrows.push({ img, x: from.x + from.facing * 46, gy: from.gy, z: 96, vx: from.facing * 530, alive: true });
    audio.arrowRelease();
  }

  private updateArrows(dt: number): void {
    const p = this.player;
    for (const a of this.arrows) {
      if (!a.alive) continue;
      a.x += a.vx * dt;
      a.img.x = a.x;
      a.img.y = a.gy - a.z;
      if (a.x < 10 || a.x > WORLD_W - 10) { a.alive = false; a.img.destroy(); continue; }
      // A jump (apex ~105px) carries the player over the arrow's line.
      if (p.hp > 0 && Math.abs(p.x - a.x) < 24 && Math.abs(p.gy - a.gy) < 18 && p.z < 70) {
        a.alive = false;
        a.img.destroy();
        const archer = this.enemies.find((e) => e.kind === 'archer' && e.alive) ?? p;
        this.damageFighter(p, archer, STATS.archer.damage, 120, false, { source: 'arrow' });
      }
    }
    this.arrows = this.arrows.filter((a) => a.alive);
  }

  private clearArrows(): void {
    for (const a of this.arrows) a.img.destroy();
    this.arrows = [];
    for (const v of this.volleys) v.marker.destroy();
    this.volleys = [];
    this.aimLine.setVisible(false);
  }

  private updateVolleys(dt: number): void {
    void dt;
    const p = this.player;
    for (const v of this.volleys) {
      if (v.struck) continue;
      v.marker.setAlpha(0.3 + 0.25 * Math.sin(this.now / 60));
      if (this.now >= v.strikeAt) {
        v.struck = true;
        v.marker.destroy();
        const img = this.add.image(v.x, v.gy - 240, 'arrow').setAngle(90);
        img.depth = v.gy + 4;
        this.tweens.add({ targets: img, y: v.gy - 6, duration: 130, onComplete: () => img.destroy() });
        audio.arrowRelease();
        if (p.hp > 0 && Math.abs(p.x - v.x) < 46 && Math.abs(p.gy - v.gy) <= 20 && p.z < 40) {
          this.damageFighter(p, this.boss ?? p, 9, 80, false, { source: 'arrow' });
        }
      }
    }
    this.volleys = this.volleys.filter((v) => !v.struck);
  }

  // ---------------------------------------------------------- enemies
  private updateEnemy(e: Fighter, dt: number): void {
    if (e.state === 'dead' || e.state === 'grabbed' || e.state === 'thrown') {
      if (e.state === 'grabbed') e.stateT += dt * 1000;
      return;
    }
    e.stateT += dt * 1000;
    const p = this.player;
    const st = STATS[e.kind];

    if (e.state === 'down') {
      if (e.hp <= 0) {
        if (e.stateT > 900) {
          e.state = 'dead';
          this.tweens.add({ targets: [e.sprite, e.shadow], alpha: 0, duration: 450, onComplete: () => e.destroy() });
        }
      } else if (e.stateT > 700 && e.z === 0) {
        e.state = 'idle';
        e.stateT = 0;
      }
      return;
    }
    if (e.state === 'hurt') {
      e.play('idle');
      if (e.stateT > (e.d.hurtMs ?? 260)) { e.state = 'idle'; e.stateT = 0; e.d.hurtMs = 260; }
      return;
    }
    if (e.kind === 'yujin') {
      this.updateBoss(e, dt);
      return;
    }
    if (e.kind === 'archer') {
      this.updateArcher(e, dt);
      return;
    }

    const dx = p.x - e.x;
    const distX = Math.abs(dx);
    const distY = Math.abs(p.gy - e.gy);

    if (e.state === 'attack') {
      const activeLen = 130;
      if (e.stateT < e.atkStrikeAt) {
        // Wind-up tell: spear plants its foot, brute flushes with effort.
        if (e.kind === 'brute' || e.kind === 'spear') {
          e.sprite.setTint(Math.sin(this.now / 55) > 0 ? 0xffc8a8 : 0xffffff);
        }
      } else {
        if (e.sprite.tintTopLeft !== 0xffffff) e.sprite.clearTint();
        if (e.stateT < e.atkStrikeAt + activeLen) {
          e.x += e.facing * (e.kind === 'spear' ? 46 : 30) * dt;
          const spec: AttackSpec = { startup: st.windup, active: activeLen, recovery: st.recovery, damage: st.damage, reach: st.reach, knockback: e.kind === 'brute' ? 300 : 180, knockdown: e.kind === 'brute', heavy: e.kind === 'brute' };
          if (p.hp > 0 && !e.hitSet.has(p) && this.inHitRange(e, p, spec)) {
            e.hitSet.add(p);
            this.damageFighter(p, e, spec.damage, spec.knockback, spec.knockdown, { source: 'melee' });
            if (e.kind === 'brute') { audio.slam(); this.cameras.main.shake(130, 0.006); }
          }
        }
      }
      if (e.stateT >= e.atkTotal) {
        e.state = 'recover';
        e.stateT = 0;
        this.releaseToken(e);
      }
      return;
    }
    if (e.state === 'recover') {
      e.play('idle');
      if (e.stateT >= st.recovery) { e.state = 'idle'; e.stateT = 0; }
      return;
    }

    // Positioning. Enemies never start new attacks on a downed player.
    e.facing = dx >= 0 ? 1 : -1;
    const inLane = distY <= DEPTH_TOLERANCE - 6;
    if (!inLane || distX > st.preferred + 12) {
      if (distX > 8) e.x += Math.sign(dx) * st.speed * dt;
      if (!inLane) e.gy += Math.sign(p.gy - e.gy) * st.depthSpeed * dt;
      e.state = 'walk';
      e.play('walk');
    } else {
      e.state = 'idle';
      e.play('idle');
      e.thinkT += dt * 1000;
      if (e.thinkT > 720) { e.thinkT = 0; e.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      e.gy += e.strafeDir * st.depthSpeed * 0.4 * dt;
      if (distX <= st.reach + 20 && inLane && p.hp > 0 && this.tryTakeToken(e)) {
        e.state = 'attack';
        e.stateT = 0;
        e.hitSet.clear();
        e.atkStrikeAt = st.windup;
        e.atkTotal = Math.round(st.windup / e.strikeFrac('attack')) + 140;
        e.play('attack', e.atkTotal);
        audio.swing();
      }
    }
  }

  private updateArcher(e: Fighter, dt: number): void {
    const p = this.player;
    const st = STATS.archer;
    const dx = p.x - e.x;
    const distX = Math.abs(dx);
    const distY = Math.abs(p.gy - e.gy);

    if (e.state === 'attack') {
      // Aim: bow rises, lane is indicated, release at the windup mark.
      this.aimLine.setVisible(true);
      const len = Math.min(430, Math.max(120, distX));
      this.aimLine.width = len;
      this.aimLine.x = e.x + e.facing * (len / 2);
      this.aimLine.y = e.gy - 96;
      this.aimLine.depth = e.gy + 3;
      if (!e.released && e.stateT >= e.atkStrikeAt) {
        e.released = true;
        this.fireArrow(e);
      }
      if (e.stateT >= e.atkTotal) {
        e.state = 'recover';
        e.stateT = 0;
        this.aimLine.setVisible(false);
        this.releaseToken(e);
      }
      return;
    }
    if (e.state === 'recover') {
      e.play('idle');
      if (e.stateT >= st.recovery) { e.state = 'idle'; e.stateT = 0; }
      return;
    }
    this.aimLine.setVisible(this.enemies.some((o) => o.kind === 'archer' && o.state === 'attack'));
    e.facing = dx >= 0 ? 1 : -1;
    let moving = false;
    if (distX < 175) {
      e.x -= Math.sign(dx) * st.speed * dt; // keep distance, flinches close
      moving = true;
    } else if (distX > 430) {
      e.x += Math.sign(dx) * st.speed * dt;
      moving = true;
    }
    if (distY > 12) {
      e.gy += Math.sign(p.gy - e.gy) * st.depthSpeed * dt;
      moving = true;
    }
    e.state = moving ? 'walk' : 'idle';
    e.play(moving ? 'walk' : 'idle');
    if (!moving && distX >= 175 && distX <= 430 && distY <= 16 && p.hp > 0 && this.tryTakeRanged(e)) {
      e.state = 'attack';
      e.stateT = 0;
      e.released = false;
      e.hitSet.clear();
      e.atkStrikeAt = st.windup;
      e.atkTotal = Math.round(st.windup / e.strikeFrac('attack')) + 120;
      e.play('attack', e.atkTotal);
    }
  }

  // ---------------------------------------------------------- Yu Jin boss
  private bossPhaseOf(b: Fighter): number {
    return b.hp > b.maxHp * 0.6 ? 1 : b.hp > b.maxHp * 0.3 ? 2 : 3;
  }

  private updateBoss(b: Fighter, dt: number): void {
    const p = this.player;
    const st = STATS.yujin;
    if (this.now < this.bossIntroUntil) {
      b.play('idle');
      b.facing = p.x >= b.x ? 1 : -1;
      return;
    }
    // Phase transitions fire once.
    const phase = this.bossPhaseOf(b);
    if (phase >= 2 && !b.d.signaled && !this.bossPattern && b.state !== 'attack') {
      b.d.signaled = 1;
      this.startBossPattern(b, 'signal');
      return;
    }
    if (phase === 3 && !b.d.phase3Shown) {
      b.d.phase3Shown = 1;
      this.showBanner('Yu Jin rages! / 于禁震怒', 1300);
    }
    // Anti-stunlock guard burst (own tell + recovery; cooldown-limited).
    if (!this.bossPattern && b.state !== 'attack' && b.recentHits.length >= 5 && this.now >= (b.d.burstReadyAt ?? 0)) {
      b.recentHits = [];
      this.startBossPattern(b, 'burst');
      return;
    }
    if (this.bossPattern) {
      this.updateBossPattern(b, dt);
      return;
    }
    if (b.state === 'attack') {
      const activeLen = 130;
      if (b.stateT < b.atkStrikeAt) {
        b.sprite.setTint(Math.sin(this.now / 45) > 0 ? 0xffa292 : 0xffffff);
      } else {
        if (b.sprite.tintTopLeft !== 0xffffff) b.sprite.clearTint();
        if (b.stateT < b.atkStrikeAt + activeLen) {
          b.x += b.facing * 34 * dt;
          const spec: AttackSpec = { startup: st.windup, active: activeLen, recovery: st.recovery, damage: st.damage, reach: st.reach, knockback: 220, knockdown: false, heavy: true };
          if (p.hp > 0 && !b.hitSet.has(p) && this.inHitRange(b, p, spec)) {
            b.hitSet.add(p);
            this.damageFighter(p, b, spec.damage, spec.knockback, false, { source: 'melee' });
          }
        }
      }
      if (b.stateT >= b.atkTotal) {
        // Two-hit sabre: a second swing follows the first.
        if ((b.d.sabreLeft ?? 0) > 0) {
          b.d.sabreLeft -= 1;
          b.stateT = 0;
          b.hitSet.clear();
          b.atkStrikeAt = 300;
          b.atkTotal = Math.round(300 / b.strikeFrac('attack')) + 120;
          b.play('attack', b.atkTotal);
          audio.swing();
        } else {
          b.state = 'recover';
          b.stateT = 0;
          this.releaseToken(b);
          this.openBossPunishWindow();
        }
      }
      return;
    }
    if (b.state === 'recover') {
      b.play('idle');
      const rec = b.d.recoverMs ?? st.recovery;
      if (b.stateT >= rec) { b.state = 'idle'; b.stateT = 0; b.d.recoverMs = st.recovery; this.bossPunishWindow = 0; }
      return;
    }

    // Approach, then pick a pattern (never three in a row of one kind).
    const dx = p.x - b.x;
    const distX = Math.abs(dx);
    const distY = Math.abs(p.gy - b.gy);
    b.facing = dx >= 0 ? 1 : -1;
    const speedScale = phase === 3 ? 1.3 : 1;
    const thinkReady = this.now >= (b.d.nextThinkAt ?? 0);
    if (thinkReady && p.hp > 0 && p.state !== 'down') {
      const pool: string[] = [];
      if (distX <= st.reach + 30 && distY <= DEPTH_TOLERANCE) pool.push('sabre', 'sabre');
      if (distX >= 180) pool.push('charge');
      if (phase >= 2 && distX >= 140) pool.push('leap');
      if (phase >= 2 && distX >= 200) pool.push('volley');
      const filtered = pool.filter((pat) => !(GameScene.PATTERN_CODES[pat] === (b.d.lastPatternCode ?? 0) && (b.d.lastPatternCount ?? 0) >= 2));
      const choices = filtered.length > 0 ? filtered : pool;
      if (choices.length > 0 && this.tryTakeToken(b)) {
        const pat = choices[Math.floor(Math.random() * choices.length)];
        if (pat === 'sabre') {
          this.noteBossPattern(b, 'sabre');
          b.state = 'attack';
          b.stateT = 0;
          b.hitSet.clear();
          b.d.sabreLeft = 1;
          b.atkStrikeAt = st.windup;
          b.atkTotal = Math.round(st.windup / b.strikeFrac('attack')) + 140;
          b.play('attack', b.atkTotal);
          audio.swing();
        } else {
          this.startBossPattern(b, phase === 3 && pat === 'charge' ? 'doublecharge' : pat);
        }
        return;
      }
    }
    if (distX > st.preferred + 10 || distY > DEPTH_TOLERANCE - 6) {
      if (distX > 8) b.x += Math.sign(dx) * st.speed * speedScale * dt;
      if (distY > DEPTH_TOLERANCE - 6) b.gy += Math.sign(p.gy - b.gy) * st.depthSpeed * dt;
      b.state = 'walk';
      b.play('walk');
    } else {
      b.state = 'idle';
      b.play('idle');
    }
  }

  private static PATTERN_CODES: Record<string, number> = { sabre: 1, charge: 2, doublecharge: 2, leap: 3, volley: 4, signal: 5, burst: 6 };

  private noteBossPattern(b: Fighter, name: string): void {
    const code = GameScene.PATTERN_CODES[name] ?? 0;
    b.d.lastPatternCount = (b.d.lastPatternCode ?? 0) === code ? (b.d.lastPatternCount ?? 0) + 1 : 1;
    b.d.lastPatternCode = code;
  }

  private openBossPunishWindow(): void {
    this.bossWindowSeq += 1;
    this.bossPunishWindow = this.bossWindowSeq;
  }

  private startBossPattern(b: Fighter, name: string): void {
    this.bossPattern = name;
    this.noteBossPattern(b, name);
    b.d.patternT = 0;
    b.d.patternStage = 0;
    b.hitSet.clear();
    if (!b.attackToken) this.tryTakeToken(b);
    if (name === 'signal') {
      this.showBanner('Yu Jin signals! / 旗语', 1200);
      audio.chargeTell();
      b.play('attack', 900);
    } else if (name === 'charge' || name === 'doublecharge') {
      b.d.chargeDir = this.player.x >= b.x ? 1 : -1;
      b.d.chargePasses = name === 'doublecharge' ? 2 : 1;
      b.d.chargeGy = b.gy;
      audio.chargeTell();
      const sec = SECTIONS[SECTIONS.length - 1];
      this.chargeLane.width = sec.right - sec.left - 40;
      this.chargeLane.x = (sec.left + sec.right) / 2;
      this.chargeLane.y = b.gy;
      this.chargeLane.setVisible(true);
      b.play('idle');
    } else if (name === 'leap') {
      b.d.leapTargetX = this.player.x;
      b.d.leapTargetGy = this.player.gy;
      audio.chargeTell();
      b.play('idle');
    } else if (name === 'volley') {
      audio.chargeTell();
      b.play('attack', 800);
    } else if (name === 'burst') {
      b.d.burstReadyAt = this.now + 6000;
      audio.chargeTell();
      b.sprite.setTint(0xffd76a);
    }
  }

  private endBossPattern(b: Fighter, recoverMs: number): void {
    this.bossPattern = null;
    this.chargeLane.setVisible(false);
    if (b.sprite.tintTopLeft !== 0xffffff) b.sprite.clearTint();
    b.state = 'recover';
    b.stateT = 0;
    b.d.recoverMs = recoverMs;
    b.d.nextThinkAt = this.now + recoverMs + 350;
    this.releaseToken(b);
    this.openBossPunishWindow();
  }

  private updateBossPattern(b: Fighter, dt: number): void {
    const name = this.bossPattern;
    if (!name) return;
    b.d.patternT = (b.d.patternT ?? 0) + dt * 1000;
    const t = b.d.patternT;
    const p = this.player;
    const stage = b.d.patternStage ?? 0;

    if (name === 'signal') {
      if (stage === 0 && t >= 550) {
        b.d.patternStage = 1;
        for (const s of BOSS_REINFORCEMENTS) {
          if (s.delay <= 0) this.spawnEnemy(s.kind, s.x, s.gy);
          else this.pendingSpawns.push({ at: this.now + s.delay, def: s });
        }
        this.showBanner('Reinforcements! / 援兵', 1100);
      }
      if (t >= 950) this.endBossPattern(b, 900);
      return;
    }
    if (name === 'charge' || name === 'doublecharge') {
      const dir = (b.d.chargeDir ?? 1) as 1 | -1;
      if (stage === 0) {
        // Marked-lane telegraph; the rest of the deck stays safe.
        b.facing = dir;
        b.sprite.setTint(Math.sin(this.now / 50) > 0 ? 0xffa292 : 0xffffff);
        if (t >= 700) {
          b.d.patternStage = 1;
          b.d.patternT = 0;
          b.hitSet.clear();
          b.sprite.clearTint();
          b.play('walk');
          b.sprite.anims.timeScale = 2.4;
          audio.swing();
        }
      } else if (stage === 1) {
        b.x += dir * 640 * dt;
        b.gy = b.d.chargeGy ?? b.gy;
        if (p.hp > 0 && !b.hitSet.has(p) && Math.abs(p.x - b.x) < 62 && Math.abs(p.gy - b.gy) <= 24 && p.z < 90) {
          b.hitSet.add(p);
          this.damageFighter(p, b, 14, 330, true, { source: 'melee', heavy: true });
          this.cameras.main.shake(150, 0.006);
        }
        const sec = SECTIONS[SECTIONS.length - 1];
        const atEdge = dir > 0 ? b.x >= sec.right - 70 : b.x <= sec.left + 70;
        if (atEdge || t >= 1150) {
          b.sprite.anims.timeScale = 1;
          b.d.chargePasses = (b.d.chargePasses ?? 1) - 1;
          if ((b.d.chargePasses ?? 0) > 0) {
            // Visible turn before the second pass.
            b.d.patternStage = 2;
            b.d.patternT = 0;
            b.d.chargeDir = -dir;
            b.d.chargeGy = b.gy;
            this.chargeLane.y = b.gy;
            audio.chargeTell();
            b.play('idle');
          } else {
            this.endBossPattern(b, name === 'doublecharge' ? 1500 : 1150);
          }
        }
      } else if (stage === 2) {
        b.facing = (b.d.chargeDir ?? 1) as 1 | -1;
        b.sprite.setTint(Math.sin(this.now / 50) > 0 ? 0xffa292 : 0xffffff);
        this.floatTextOnce(b, 'He turns!', t);
        if (t >= 620) {
          b.d.patternStage = 1;
          b.d.patternT = 0;
          b.hitSet.clear();
          b.sprite.clearTint();
          b.play('walk');
          b.sprite.anims.timeScale = 2.4;
        }
      }
      return;
    }
    if (name === 'leap') {
      if (stage === 0) {
        b.sprite.setTint(Math.sin(this.now / 50) > 0 ? 0xffa292 : 0xffffff);
        if (t >= 480) {
          b.sprite.clearTint();
          b.d.patternStage = 1;
          b.d.patternT = 0;
          const airtime = 0.78;
          b.d.leapVx = ((b.d.leapTargetX ?? b.x) - b.x) / airtime;
          b.d.leapVy = ((b.d.leapTargetGy ?? b.gy) - b.gy) / airtime;
          b.vz = 585;
          b.z = 1;
          b.play('attack', 780);
          audio.jump();
        }
      } else if (stage === 1) {
        b.x += (b.d.leapVx ?? 0) * dt;
        b.gy += (b.d.leapVy ?? 0) * dt;
        // Landing is handled by physics -> bossLeapLand().
      }
      return;
    }
    if (name === 'volley') {
      if (stage === 0 && t >= 420) {
        b.d.patternStage = 1;
        // Marked volley around the player's lane; other lanes stay safe.
        for (const off of [-95, 0, 95]) {
          const x = Phaser.Math.Clamp(p.x + off, SECTIONS[5].left + 50, SECTIONS[5].right - 50);
          const marker = this.add.ellipse(x, p.gy, 92, 40, 0xc03a28, 0.35);
          marker.depth = p.gy - 1;
          this.volleys.push({ x, gy: p.gy, strikeAt: this.now + 780, marker, struck: false });
        }
      }
      if (t >= 850) this.endBossPattern(b, 950);
      return;
    }
    if (name === 'burst') {
      if (stage === 0 && t >= 360) {
        b.d.patternStage = 1;
        audio.explosion();
        this.cameras.main.shake(140, 0.006);
        if (p.hp > 0 && Math.abs(p.x - b.x) <= 118 && Math.abs(p.gy - b.gy) <= 36 && p.z < 90) {
          this.damageFighter(p, b, 8, 340, true, { source: 'melee', heavy: true });
        }
        this.floatText(b.x, b.gy - 230, 'GUARD BURST!', '#ffd76a', 16);
      }
      if (t >= 620) {
        b.sprite.clearTint();
        this.endBossPattern(b, 820);
      }
      return;
    }
  }

  private floatTextOnce(b: Fighter, text: string, t: number): void {
    if (t < 60 && !b.d.turnTextShown) {
      b.d.turnTextShown = 1;
      this.floatText(b.x, b.gy - 230, text, '#ffd76a', 15);
      this.time.delayedCall(700, () => { b.d.turnTextShown = 0; });
    }
  }

  private bossLeapLand(): void {
    const b = this.boss;
    if (!b || this.bossPattern !== 'leap') return;
    audio.slam();
    this.cameras.main.shake(180, 0.007);
    const p = this.player;
    if (p.hp > 0 && Math.abs(p.x - b.x) <= 98 && Math.abs(p.gy - b.gy) <= 34 && p.z < 60) {
      this.damageFighter(p, b, 16, 320, true, { source: 'melee', heavy: true });
    }
    this.endBossPattern(b, 1050);
  }

  // ---------------------------------------------------------- medals & flow
  private awardMedal(id: string): void {
    if (this.medalsRun.has(id)) return;
    this.medalsRun.add(id);
    records.earnMedal(id);
    const medal = MEDALS.find((m) => m.id === id);
    audio.medal();
    this.showBanner(`🏅 ${medal?.nameEn} / ${medal?.nameZh}`, 1500);
  }

  private togglePause(): void {
    if (this.phase === 'playing') {
      this.phase = 'paused';
      this.showPauseOverlay();
    } else if (this.phase === 'paused') {
      this.phase = 'playing';
      this.hideOverlay();
    }
  }

  private toggleMute(): void {
    audio.setMuted(!audio.muted);
    records.setMuted(audio.muted);
    this.showBanner(audio.muted ? 'Muted / 静音' : 'Sound on / 声音开', 650);
  }

  private showPauseOverlay(): void {
    this.hideOverlay();
    const c = this.add.container(VIEW_W / 2, VIEW_H / 2).setScrollFactor(0).setDepth(2000);
    const bg = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.66);
    const panel = this.add.rectangle(0, 0, 640, 400, 0x1d150d, 0.96).setStrokeStyle(2, 0xc8a24a);
    const t = this.add.text(0, -168, 'Paused / 暂停', { fontFamily: 'Georgia, serif', fontSize: '32px', color: '#f0d492' }).setOrigin(0.5);
    const b = this.add.text(-300, -118, MOVE_LIST_LINES.join('\n'), { fontFamily: 'Georgia, serif', fontSize: '13px', color: '#e8e0c8', lineSpacing: 9 }).setOrigin(0, 0);
    const hint = this.add.text(0, 158, 'P / Esc resume · T title', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#9a8f74' }).setOrigin(0.5);
    c.add([bg, panel, t, b, hint]);
    this.overlay = c;
  }

  private onBossDefeated(): void {
    audio.bossMode = false;
    this.time.delayedCall(1300, () => {
      if (this.phase !== 'playing') return;
      if (!this.bossDamagedPlayer) this.awardMedal('steady-nerve');
      this.phase = 'won';
      this.endTimeSec = Math.max(1, Math.round((this.now - this.startSimTime) / 1000));
      const timeBonus = Math.min(SCORE_EVENTS.timeBonusCap, Math.max(0, SCORE_EVENTS.parTimeSec - this.endTimeSec) * SCORE_EVENTS.timeBonusPerSec);
      const total = this.totalScore() + timeBonus;
      const rank = rankForScore(total);
      const newBest = records.submitBest(this.mode, this.seed, { score: total, timeSec: this.endTimeSec, rank }, this.continues);
      this.victoryStats = { total, rank, timeSec: this.endTimeSec, newBest, timeBonus };
      audio.jingle(true);
      this.showResultsOverlay(true);
    });
  }

  private onPlayerDefeated(): void {
    audio.death();
    this.time.delayedCall(1400, () => {
      if (this.phase !== 'playing') return;
      this.phase = 'lost';
      this.endTimeSec = Math.max(1, Math.round((this.now - this.startSimTime) / 1000));
      audio.jingle(false);
      this.showResultsOverlay(false);
    });
  }

  private medalLines(): string[] {
    return MEDALS.map((m) => `${this.medalsRun.has(m.id) ? '🏅' : '○'} ${m.nameEn} / ${m.nameZh} — ${m.desc}`);
  }

  private showResultsOverlay(won: boolean): void {
    this.hideOverlay();
    const c = this.add.container(VIEW_W / 2, VIEW_H / 2).setScrollFactor(0).setDepth(2000);
    const bg = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.66);
    const panel = this.add.rectangle(0, 0, 660, 440, 0x1d150d, 0.97).setStrokeStyle(2, 0xc8a24a);
    const title = this.add.text(0, -192, won ? 'VICTORY / 胜利' : 'DEFEATED / 战败', { fontFamily: 'Georgia, serif', fontSize: '36px', color: won ? '#f0d492' : '#ff9a8a' }).setOrigin(0.5);
    const secs = this.endTimeSec;
    let body: string;
    if (won && this.victoryStats) {
      const v = this.victoryStats;
      const next = nextRankTarget(v.total);
      const bestLine = this.mode === 'arcade'
        ? (records.arcadeBest() ? `Arcade best: ${records.arcadeBest()!.score} (Rank ${records.arcadeBest()!.rank})` : '')
        : (records.remixBest(this.seed) ? `Seed ${this.seed} best: ${records.remixBest(this.seed)!.score}` : '');
      body = [
        `Defeats ${this.scoreKills} · Skill bonuses ${this.scoreSkill} · Time bonus ${v.timeBonus}`,
        `TOTAL ${v.total} — Rank ${v.rank}${v.newBest ? '  ★ NEW BEST' : ''}${this.continues > 0 && this.mode === 'arcade' ? '  (continued run: not ranked)' : ''}`,
        next ? `Next rank ${next.rank}: ${next.need} more points` : 'Top rank reached!',
        `Foes defeated ${this.kills}/${this.totalEnemies} · Best combo ${this.bestCombo} hits · Time ${secs}s · Continues ${this.continues}`,
        bestLine,
        '',
        ...this.medalLines(),
      ].join('\n');
    } else {
      body = [
        `Guan Yu / 关羽 has fallen on ${this.activeSection?.def.nameEn ?? 'the decks'}…`,
        `Score ${this.totalScore()} · Foes defeated ${this.kills} · Best combo ${this.bestCombo} · Continues ${this.continues}`,
        '',
        ...this.medalLines(),
      ].join('\n');
    }
    const b = this.add.text(0, -128, body, { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e8e0c8', align: 'center', lineSpacing: 8 }).setOrigin(0.5, 0);
    c.add([bg, panel, title, b]);

    const options: { label: string; fn: () => void }[] = won
      ? this.mode === 'arcade'
        ? [
          { label: '[1] Retry Arcade', fn: () => this.restartRun('arcade', 0) },
          { label: '[2] Play Remix (random seed)', fn: () => this.restartRun('remix', this.randomSeed()) },
          { label: '[3] Title', fn: () => this.toTitle() },
        ]
        : [
          { label: `[1] Retry This Seed (${this.seed})`, fn: () => this.restartRun('remix', this.seed) },
          { label: '[2] New Seed', fn: () => this.restartRun('remix', this.randomSeed()) },
          { label: '[3] Title', fn: () => this.toTitle() },
        ]
      : [
        { label: '[1 / Enter] Continue this deck', fn: () => this.doContinue() },
        { label: `[2] Retry ${this.mode === 'remix' ? `Seed ${this.seed}` : 'Arcade'}`, fn: () => this.restartRun(this.mode, this.seed) },
        { label: '[3] Title', fn: () => this.toTitle() },
      ];
    options.forEach((opt, i) => {
      const t = this.add.text(-200 + i * 200, 178, opt.label, { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#ffd76a' })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      t.once('pointerdown', opt.fn);
      c.add(t);
    });
    this.overlay = c;
  }

  private resultsChoice(n: number): void {
    if (this.phase === 'won') {
      if (n === 1) this.restartRun(this.mode === 'remix' ? 'remix' : 'arcade', this.mode === 'remix' ? this.seed : 0);
      else if (n === 2) this.restartRun('remix', this.mode === 'arcade' ? this.randomSeed() : this.randomSeed());
      else if (n === 3) this.toTitle();
    } else if (this.phase === 'lost') {
      if (n === 1) this.doContinue();
      else if (n === 2) this.restartRun(this.mode, this.seed);
      else if (n === 3) this.toTitle();
    }
  }

  private randomSeed(): number {
    return 1000 + Math.floor(Math.random() * 9000);
  }

  private restartRun(mode: 'arcade' | 'remix', seed: number): void {
    runConfig.mode = mode;
    runConfig.seed = seed;
    audio.bossMode = false;
    this.scene.restart();
  }

  private toTitle(): void {
    audio.bossMode = false;
    this.scene.start('title');
  }

  private doContinue(): void {
    if (this.phase !== 'lost') return;
    this.hideOverlay();
    this.phase = 'playing';
    this.continues += 1;
    // Restore the checkpoint (score/medals at the last cleared deck), so a
    // continue can never duplicate points from the failed attempt.
    const cp = this.checkpoint;
    this.scoreKills = cp.scoreKills;
    this.scoreSkill = cp.scoreSkill;
    this.kills = cp.kills;
    this.bestCombo = cp.bestCombo;
    this.medalsRun = new Set(cp.medalsRun);
    this.bossPunishEarned = cp.bossPunishEarned;
    this.chainHits = 0;
    // Clear the failed encounter.
    for (const e of this.enemies) e.destroy();
    this.enemies = [];
    this.boss = null;
    this.bossPattern = null;
    this.bossBarWrap.setVisible(false);
    audio.bossMode = false;
    this.pendingSpawns = [];
    this.pendingExplosions = [];
    this.clearArrows();
    this.chargeLane.setVisible(false);
    this.resetMast();
    this.grabTarget = null;
    const sec = this.sections.find((s) => !s.cleared);
    if (!sec) return;
    if (sec.def.id === 'burning-deck') this.mastState = 'idle';
    sec.started = false;
    sec.waveIdx = 0;
    this.activeSection = null;
    // Fresh player life at the encounter entry.
    const p = this.player;
    p.hp = p.maxHp;
    p.state = 'idle';
    p.stateT = 0;
    p.z = 0;
    p.vz = 0;
    p.vx = 0;
    p.sprite.angle = 0;
    p.sprite.setAlpha(1);
    p.iframesUntil = this.now + 1200;
    p.x = sec.def.triggerX + 4;
    p.gy = Phaser.Math.Clamp(450, sec.def.groundTop, sec.def.groundBot);
    p.facing = 1;
    p.play('idle');
    this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_H);
    this.cameras.main.centerOn(p.x + 200, VIEW_H / 2);
    this.showBanner(`Continue ${this.continues} — ${sec.def.nameEn} / 再战`, 1200);
  }

  private hideOverlay(): void {
    this.overlay?.destroy();
    this.overlay = null;
  }

  // ---------------------------------------------------------- HUD
  private updateHud(): void {
    const p = this.player;
    if (!p) return;
    this.hpBar.width = 222 * Phaser.Math.Clamp(p.hp / p.maxHp, 0, 1);
    this.hpBar.setFillStyle(p.hp / p.maxHp > 0.3 ? 0x3fae5a : 0xc03a28);
    this.scoreLabel.setText(`Score ${this.totalScore()}`);
    this.comboLabel.setText(this.chainHits >= 2 ? `${this.chainHits} HIT COMBO` : '');
    if (this.now < this.lastHitUntil && this.lastHitMax > 0) {
      this.targetLabel.setText(this.lastHitName);
      this.targetBar.width = 148 * Phaser.Math.Clamp(this.lastHitHp / this.lastHitMax, 0, 1);
    } else {
      this.targetLabel.setText('');
      this.targetBar.width = 0;
    }
    if (this.activeSection) {
      const sec = this.activeSection;
      const variant = sec.def.variants[sec.variant];
      let pending = this.pendingSpawns.length;
      for (let w = sec.waveIdx + 1; w < variant.waves.length; w += 1) pending += variant.waves[w].length;
      const alive = this.enemies.filter((e) => e.hp > 0).length;
      this.sectionLabel.setText(
        sec.def.isBoss ? '— Command deck duel —' : `${sec.def.nameEn} · Foes: ${alive + pending}`,
      );
    } else if (this.phase === 'playing') {
      const next = this.sections.find((s) => !s.cleared);
      this.sectionLabel.setText(next ? `Advance → ${next.def.nameEn}` : '');
    }
    if (this.boss && this.bossBarWrap.visible) {
      this.bossBar.width = 458 * Phaser.Math.Clamp(this.boss.hp / this.boss.maxHp, 0, 1);
      if (this.boss.hp <= 0) this.bossBarWrap.setVisible(false);
    }
  }

  // ---------------------------------------------------------- test hooks
  private exposeTestHooks(): void {
    window.__DYNASTY__ = {
      state: () => ({
        phase: this.phase,
        mode: this.mode,
        seed: this.seed,
        variants: [...this.variants],
        playerHp: this.player.hp,
        playerX: Math.round(this.player.x),
        playerGy: Math.round(this.player.gy),
        playerZ: Math.round(this.player.z),
        playerState: this.player.state,
        playerMove: this.player.moveId,
        enemiesAlive: this.enemies.filter((e) => e.hp > 0).length,
        enemies: this.enemies.map((e) => ({ kind: e.kind, hp: e.hp, x: Math.round(e.x), gy: Math.round(e.gy), z: Math.round(e.z), state: e.state })),
        bossHp: this.boss?.hp ?? null,
        bossPattern: this.bossPattern,
        bossPhase: this.boss ? this.bossPhaseOf(this.boss) : null,
        section: this.activeSection ? this.sections.indexOf(this.activeSection) : -1,
        zone: this.activeSection ? this.sections.indexOf(this.activeSection) : -1,
        sectionsCleared: this.sections.filter((s) => s.cleared).length,
        zonesCleared: this.sections.filter((s) => s.cleared).length,
        wave: this.activeSection?.waveIdx ?? -1,
        score: this.totalScore(),
        scoreKills: this.scoreKills,
        scoreSkill: this.scoreSkill,
        kills: this.kills,
        totalEnemies: this.totalEnemies,
        bestCombo: this.bestCombo,
        chainHits: this.chainHits,
        continues: this.continues,
        medalsRun: [...this.medalsRun],
        grabState: this.grabTarget ? this.grabTarget.kind : null,
        pummels: this.pummelCount,
        props: this.props.filter((pr) => pr.alive).map((pr) => ({ kind: pr.kind, x: Math.round(pr.x), gy: Math.round(pr.gy), hp: pr.hp })),
        arrows: this.arrows.length,
        volleys: this.volleys.length,
        mastState: this.mastState,
        meleeTokens: this.tokensInUse(),
        rangedTokens: this.enemies.filter((e) => e.rangedToken).length,
        lastAttackHitCount: this.lastAttackHitCount,
        muted: audio.muted,
        audioStarted: audio.started,
        bossMode: audio.bossMode,
        records: records.snapshot(),
        victory: this.victoryStats,
      }),
      teleport: (x: number, gy = 450) => { this.player.x = x; this.player.gy = gy; },
      setEnemiesGy: (gy: number) => { for (const e of this.enemies) e.gy = gy; },
      hurtPlayer: (n: number) => this.damageFighter(this.player, this.player, n, 0, false, { source: 'test', pierceIframes: true }),
      setPlayerHp: (n: number) => { this.player.hp = n; },
      hurtBoss: (n: number) => { if (this.boss) this.damageFighter(this.boss, this.player, n, 0, false, { heavy: true, source: 'test' }); },
      setBossHp: (n: number) => { if (this.boss) this.boss.hp = n; },
      killAllEnemies: () => { for (const e of [...this.enemies]) if (e.kind !== 'yujin') this.damageFighter(e, this.player, 9999, 0, true, { heavy: true, source: 'test' }); },
      spawnEnemy: (kind: EnemyKind, x: number, gy: number) => this.spawnEnemy(kind, x, gy).kind,
      startRemix: (seed: number) => this.restartRun('remix', seed),
      startArcade: () => this.restartRun('arcade', 0),
      grabNow: () => this.doAttackPress(),
      explodeNearestBarrel: () => {
        const b = this.props.find((pr) => pr.alive && pr.kind === 'barrel');
        if (b) this.explodeBarrel(b);
      },
    };
  }
}
