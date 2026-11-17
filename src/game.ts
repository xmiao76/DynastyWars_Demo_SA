import Phaser from 'phaser';
import { audio } from './audio';
import { manifests, VIEW_H, VIEW_W } from './main';

// ---------- world constants ----------
export const WORLD_W = 3400;
const GROUND_TOP = 398;
const GROUND_BOT = 498;
const DEPTH_TOLERANCE = 30;
const GRAVITY = 1500;

type FighterKind = 'player' | 'spearman' | 'blader' | 'boss';
type FighterState =
  | 'idle'
  | 'walk'
  | 'attack'
  | 'windup'
  | 'recover'
  | 'hurt'
  | 'down'
  | 'dead';

interface AttackSpec {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  reach: number;
  knockback: number;
  knockdown: boolean;
}

// Timings are aligned to the Guan Yu attack sprite: wind-up frames 0-3,
// visible strike at frames 5-6 of 9 (~55%), recovery 7-8. The animation is
// time-scaled in code so it spans exactly startup+active+recovery.
const PLAYER_COMBO: AttackSpec[] = [
  { startup: 150, active: 90, recovery: 110, damage: 8, reach: 100, knockback: 140, knockdown: false },
  { startup: 140, active: 90, recovery: 110, damage: 9, reach: 100, knockback: 160, knockdown: false },
  { startup: 190, active: 110, recovery: 200, damage: 15, reach: 110, knockback: 340, knockdown: true },
];
const AIR_ATTACK: AttackSpec = { startup: 120, active: 140, recovery: 100, damage: 11, reach: 95, knockback: 220, knockdown: false };

interface KindStats {
  hp: number;
  speed: number;
  depthSpeed: number;
  damage: number;
  reach: number;
  windup: number;
  recovery: number;
  score: number;
  tint?: number;
  canvasDisplayH: number;
  char: string;
}

const STATS: Record<FighterKind, KindStats> = {
  player: { hp: 100, speed: 230, depthSpeed: 125, damage: 0, reach: 0, windup: 0, recovery: 0, score: 0, canvasDisplayH: 275, char: 'guanyu' },
  spearman: { hp: 32, speed: 95, depthSpeed: 55, damage: 7, reach: 98, windup: 300, recovery: 620, score: 100, canvasDisplayH: 255, char: 'soldier' },
  blader: { hp: 24, speed: 135, depthSpeed: 80, damage: 5, reach: 70, windup: 220, recovery: 480, score: 120, tint: 0xd8a08a, canvasDisplayH: 255, char: 'soldier' },
  boss: { hp: 340, speed: 70, depthSpeed: 42, damage: 18, reach: 130, windup: 680, recovery: 1150, score: 1000, canvasDisplayH: 345, char: 'boss' },
};

class Fighter {
  kind: FighterKind;
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Ellipse;
  x: number;
  gy: number; // ground y (feet, depth lane)
  z = 0; // airborne height
  vz = 0;
  vx = 0; // knockback velocity
  facing: 1 | -1 = 1;
  hp: number;
  maxHp: number;
  state: FighterState = 'idle';
  stateT = 0; // ms in current state
  combo = 0;
  comboQueued = false;
  hitSet = new Set<Fighter>();
  iframesUntil = 0;
  attackToken = false;
  thinkT = 0;
  strafeDir = 1;
  bossAddsSpawned = false;
  atkStrikeAt = 0; // ms into attack state when the strike becomes active
  atkTotal = 0; // ms total attack-state duration (anim-aligned)

  constructor(scene: Phaser.Scene, kind: FighterKind, x: number, gy: number) {
    this.kind = kind;
    this.x = x;
    this.gy = gy;
    const st = STATS[kind];
    this.hp = st.hp;
    this.maxHp = st.hp;
    const m = manifests[st.char as keyof typeof manifests];
    const firstKey = scene.textures.exists(`${st.char}-idle-0`)
      ? `${st.char}-idle-0`
      : `${st.char}-fallback`;
    this.sprite = scene.add.sprite(x, gy, firstKey);
    const cw = m?.canvas[0] ?? 512;
    const ch = m?.canvas[1] ?? 512;
    this.sprite.setOrigin((m?.originX ?? cw / 2) / cw, (m?.groundY ?? ch * 0.92) / ch);
    this.sprite.setDisplaySize(st.canvasDisplayH * (cw / ch), st.canvasDisplayH);
    if (st.tint) this.sprite.setTint(st.tint);
    this.shadow = scene.add.ellipse(x, gy + 4, 74, 16, 0x000000, 0.35);
    if (kind === 'boss') this.shadow.setSize(110, 22);
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get airborne(): boolean {
    return this.z > 0;
  }

  syncVisual(): void {
    this.sprite.x = this.x;
    this.sprite.y = this.gy - this.z;
    this.sprite.depth = this.gy;
    this.sprite.flipX = this.facing < 0;
    this.shadow.x = this.x;
    this.shadow.y = this.gy + 4;
    this.shadow.depth = this.gy - 1;
    const shScale = Phaser.Math.Clamp(1 - this.z / 300, 0.45, 1);
    this.shadow.setScale(shScale);
    this.shadow.setAlpha(0.35 * shScale);
  }

  /** Fraction of the attack animation at which the visible strike lands. */
  static strikeFrac(kind: FighterKind): number {
    if (kind === 'boss') return 0.62; // slam at frames 6-7 of 10
    if (kind === 'player') return 0.55; // strike at frames 5-6 of 9
    return 0.68; // soldier thrust extension at frames 5-6 of 7
  }

  play(action: string, totalMs?: number): void {
    const key = `${STATS[this.kind].char}-${action}`;
    if (this.sprite.scene.anims.exists(key)) {
      if (this.sprite.anims.currentAnim?.key !== key || action === 'attack') {
        this.sprite.play(key);
      }
      // Optionally time-scale a one-shot animation to span an exact
      // duration so gameplay timing and the visible strike line up.
      if (totalMs && this.sprite.anims.currentAnim) {
        const base = this.sprite.anims.currentAnim.duration;
        this.sprite.anims.timeScale = base > 0 ? base / totalMs : 1;
      } else if (action !== 'attack') {
        this.sprite.anims.timeScale = 1;
      }
    }
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}

interface Zone {
  triggerX: number;
  left: number;
  right: number;
  spawns: { kind: FighterKind; dx: number; gy: number }[];
  started: boolean;
  cleared: boolean;
  isBoss?: boolean;
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
  private zones: Zone[] = [];
  private activeZone: Zone | null = null;
  private boss: Fighter | null = null;
  private score = 0;
  private kills = 0;
  private startTime = 0;
  private phase: 'playing' | 'paused' | 'won' | 'lost' = 'playing';
  private hitStopUntil = 0;
  private waveLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  private hpBar!: Phaser.GameObjects.Rectangle;
  private bossBarWrap!: Phaser.GameObjects.Container;
  private bossBar!: Phaser.GameObjects.Rectangle;
  private goArrow!: Phaser.GameObjects.Text;
  private overlay: Phaser.GameObjects.Container | null = null;
  private slashFx!: Phaser.GameObjects.Image;
  private lastAttackHitCount = 0;

  constructor() {
    super('game');
  }

  create(): void {
    this.enemies = [];
    this.boss = null;
    this.activeZone = null;
    this.score = 0;
    this.kills = 0;
    this.phase = 'playing';
    this.overlay = null;
    this.hitStopUntil = 0;
    this.lastAttackHitCount = 0;
    this.startTime = this.time.now;

    this.buildBackdrop();
    this.buildFxTextures();

    this.player = new Fighter(this, 'player', 130, 450);
    this.player.facing = 1;
    this.player.play('idle');

    this.zones = [
      {
        triggerX: 430, left: 60, right: 860,
        spawns: [
          { kind: 'spearman', dx: 720, gy: 430 },
          { kind: 'spearman', dx: 790, gy: 475 },
        ],
        started: false, cleared: false,
      },
      {
        triggerX: 1180, left: 820, right: 1720,
        spawns: [
          { kind: 'spearman', dx: 1500, gy: 425 },
          { kind: 'blader', dx: 1580, gy: 470 },
          { kind: 'blader', dx: 1000, gy: 455 },
          { kind: 'spearman', dx: 1650, gy: 445 },
        ],
        started: false, cleared: false,
      },
      {
        triggerX: 2050, left: 1680, right: 2580,
        spawns: [
          { kind: 'blader', dx: 2350, gy: 430 },
          { kind: 'spearman', dx: 2420, gy: 470 },
          { kind: 'blader', dx: 2480, gy: 445 },
          { kind: 'spearman', dx: 1880, gy: 460 },
          { kind: 'blader', dx: 1950, gy: 425 },
        ],
        started: false, cleared: false,
      },
      {
        triggerX: 2780, left: 2540, right: WORLD_W - 40,
        spawns: [{ kind: 'boss', dx: 3120, gy: 450 }],
        started: false, cleared: false, isBoss: true,
      },
    ];

    this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_H);
    this.cameras.main.startFollow(this.player.sprite, true, 0.12, 0);
    this.cameras.main.setDeadzone(160, 0);

    this.buildHud();

    const kb = this.input.keyboard;
    if (!kb) throw new Error('keyboard unavailable');
    this.cursors = kb.createCursorKeys();
    this.keys = kb.addKeys('W,A,S,D,J,K,M,R') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.on('keydown-J', () => this.onAttackPressed());
    kb.on('keydown-K', () => this.onJumpPressed());
    kb.on('keydown-ESC', () => this.togglePause());
    kb.on('keydown-M', () => this.toggleMute());
    kb.on('keydown-R', () => {
      if (this.phase !== 'playing') this.scene.restart();
    });
    kb.on('keydown-ENTER', () => {
      if (this.phase !== 'playing' && this.phase !== 'paused') this.scene.restart();
    });

    // Safe warm-up dummy target area is zone 1 (two weak spearmen).
    this.showBanner('Advance!  前进 →', 1800);
    this.exposeTestHooks();
  }

  // ---------------------------------------------------------- setup helpers
  private buildBackdrop(): void {
    const tex = this.textures.get('bg-battlefield');
    const src = tex.getSourceImage() as { width: number; height: number };
    // The panorama already contains a walkable dirt lower portion, so it is
    // shown full-height and fighters walk directly on the painted ground.
    const scaleH = VIEW_H;
    const dispW = (src.width / Math.max(1, src.height)) * scaleH;
    for (let x = 0; x < WORLD_W + dispW; x += dispW - 2) {
      const img = this.add.image(x, 0, 'bg-battlefield').setOrigin(0, 0);
      img.setDisplaySize(dispW, scaleH);
      img.depth = -100;
    }
    if (this.textures.exists('bg-camp')) {
      const ctex = this.textures.get('bg-camp');
      const csrc = ctex.getSourceImage() as { width: number; height: number };
      const gw = (csrc.width / Math.max(1, csrc.height)) * scaleH;
      const gate = this.add.image(WORLD_W + 4, 0, 'bg-camp').setOrigin(1, 0);
      gate.setDisplaySize(gw, scaleH);
      gate.depth = -90;
      // Overflow copy so camera overscroll past the world edge in the boss
      // arena still shows camp scenery instead of the field panorama.
      const over = this.add.image(WORLD_W + 2, 0, 'bg-camp').setOrigin(0, 0);
      over.setDisplaySize(gw, scaleH);
      over.setFlipX(true);
      over.depth = -90;
    }
    // Subtle shading to read the walkable lane band on the painted dirt.
    const lane = this.add.rectangle(0, GROUND_TOP - 26, WORLD_W, VIEW_H - (GROUND_TOP - 26), 0x2a1c0c, 0.13).setOrigin(0, 0);
    lane.depth = -80;
    const laneEdge = this.add.rectangle(0, GROUND_TOP - 26, WORLD_W, 3, 0x000000, 0.18).setOrigin(0, 0);
    laneEdge.depth = -79;
    // Scattered ground detail.
    const rng = new Phaser.Math.RandomDataGenerator('dynasty-wars');
    for (let i = 0; i < 140; i += 1) {
      const x = rng.between(10, WORLD_W - 10);
      const y = rng.between(GROUND_TOP - 18, VIEW_H - 8);
      const e = this.add.ellipse(x, y, rng.between(12, 46), rng.between(3, 7), rng.pick([0x65502f, 0x86714a, 0x5b4a2e]), 0.8);
      e.depth = -70;
    }
    // (The painted backdrop already carries banners/towers; code-drawn
    // flags on top of it only clashed, so none are added.)
  }

  private buildFxTextures(): void {
    if (!this.textures.exists('slash')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.lineStyle(10, 0xffffff, 0.9);
      g.beginPath();
      g.arc(20, 60, 52, Phaser.Math.DegToRad(-70), Phaser.Math.DegToRad(55), false);
      g.strokePath();
      g.lineStyle(5, 0xbfe8ff, 0.9);
      g.beginPath();
      g.arc(20, 60, 40, Phaser.Math.DegToRad(-60), Phaser.Math.DegToRad(45), false);
      g.strokePath();
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
    this.slashFx = this.add.image(-200, -200, 'slash').setAlpha(0).setDepth(900);
  }

  private buildHud(): void {
    const topBar = this.add.rectangle(0, 0, VIEW_W, 54, 0x100c08, 0.72).setOrigin(0, 0).setScrollFactor(0).setDepth(1000);
    void topBar;
    this.add.text(16, 8, 'Guan Yu / 关羽', { fontFamily: 'Georgia, serif', fontSize: '17px', color: '#f0d492' }).setScrollFactor(0).setDepth(1001);
    this.add.rectangle(16, 32, 224, 13, 0x3a1512).setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.hpBar = this.add.rectangle(17, 33, 222, 11, 0x3fae5a).setOrigin(0, 0).setScrollFactor(0).setDepth(1002);
    this.waveLabel = this.add.text(VIEW_W / 2, 10, '', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e8e0c8' }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1001);
    this.scoreLabel = this.add.text(VIEW_W - 16, 8, 'Score 0', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e8e0c8' }).setOrigin(1, 0).setScrollFactor(0).setDepth(1001);
    this.add.text(VIEW_W - 16, 30, 'M: mute · Esc: pause', { fontSize: '12px', color: '#9a8f74', fontFamily: 'Georgia, serif' }).setOrigin(1, 0).setScrollFactor(0).setDepth(1001);
    this.add.text(12, VIEW_H - 22, 'WASD/←↑↓→ move · J attack · K jump', { fontSize: '13px', color: '#cbbd96', fontFamily: 'Georgia, serif' }).setScrollFactor(0).setDepth(1001);

    this.bossBarWrap = this.add.container(VIEW_W / 2, VIEW_H - 46).setScrollFactor(0).setDepth(1001).setVisible(false);
    const label = this.add.text(0, -16, 'Wei Champion / 魏将', { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#ffb0a0' }).setOrigin(0.5, 1);
    const bgRect = this.add.rectangle(0, 0, 460, 14, 0x3a1512).setOrigin(0.5);
    this.bossBar = this.add.rectangle(-229, 0, 458, 12, 0xc03a28).setOrigin(0, 0.5);
    this.bossBarWrap.add([label, bgRect, this.bossBar]);

    this.goArrow = this.add.text(VIEW_W - 90, 240, 'GO →', { fontFamily: 'Georgia, serif', fontSize: '34px', color: '#ffd76a', stroke: '#000', strokeThickness: 4 }).setScrollFactor(0).setDepth(1001).setVisible(false);
    this.tweens.add({ targets: this.goArrow, x: VIEW_W - 70, duration: 450, yoyo: true, repeat: -1 });
  }

  private showBanner(text: string, ms: number): void {
    const t = this.add.text(VIEW_W / 2, 120, text, { fontFamily: 'Georgia, serif', fontSize: '30px', color: '#ffd76a', stroke: '#2a1a08', strokeThickness: 5 }).setOrigin(0.5).setScrollFactor(0).setDepth(1500);
    this.tweens.add({ targets: t, alpha: 0, delay: ms, duration: 500, onComplete: () => t.destroy() });
  }

  private exposeTestHooks(): void {
    window.__DYNASTY__ = {
      state: () => ({
        phase: this.phase,
        playerHp: this.player.hp,
        playerX: Math.round(this.player.x),
        playerGy: Math.round(this.player.gy),
        playerZ: Math.round(this.player.z),
        playerState: this.player.state,
        enemiesAlive: this.enemies.filter((e) => e.hp > 0).length,
        enemies: this.enemies.map((e) => ({ kind: e.kind, hp: e.hp, x: Math.round(e.x), gy: Math.round(e.gy), state: e.state })),
        bossHp: this.boss?.hp ?? null,
        zone: this.activeZone ? this.zones.indexOf(this.activeZone) : -1,
        zonesCleared: this.zones.filter((z) => z.cleared).length,
        score: this.score,
        lastAttackHitCount: this.lastAttackHitCount,
        muted: audio.muted,
        audioStarted: audio.started,
      }),
      teleport: (x: number, gy = 450) => { this.player.x = x; this.player.gy = gy; },
      setEnemiesGy: (gy: number) => { for (const e of this.enemies) e.gy = gy; },
      hurtPlayer: (n: number) => this.damageFighter(this.player, null, n, 0, false),
      setPlayerHp: (n: number) => { this.player.hp = n; },
      hurtBoss: (n: number) => { if (this.boss) this.damageFighter(this.boss, this.player, n, 0, false); },
      killAllEnemies: () => { for (const e of [...this.enemies]) if (e.kind !== 'boss') this.damageFighter(e, this.player, 9999, 0, true); },
    };
  }

  // ---------------------------------------------------------- input
  private onAttackPressed(): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.airborne) {
      if (p.state !== 'attack') this.startPlayerAttack(AirAttackShim);
      return;
    }
    if (p.state === 'attack') {
      if (p.combo < PLAYER_COMBO.length - 1) p.comboQueued = true;
      return;
    }
    if (p.state === 'hurt' || p.state === 'down') return;
    p.combo = 0;
    this.startPlayerAttack(PLAYER_COMBO[0]);
  }

  private startPlayerAttack(spec: AttackSpec): void {
    const p = this.player;
    p.state = 'attack';
    p.stateT = 0;
    p.hitSet.clear();
    p.comboQueued = false;
    this.lastAttackHitCount = 0;
    (p as Fighter & { spec?: AttackSpec }).spec = spec;
    p.play('attack', spec.startup + spec.active + spec.recovery);
    audio.swing();
    // Slash visual.
    this.slashFx.setPosition(p.x + p.facing * 62, p.gy - p.z - 92);
    this.slashFx.setFlipX(p.facing < 0);
    this.slashFx.setDepth(p.gy + 5);
    this.slashFx.setAlpha(0.95);
    this.slashFx.setScale(p.combo === 2 ? 1.5 : 1.15);
    this.tweens.killTweensOf(this.slashFx);
    this.tweens.add({ targets: this.slashFx, alpha: 0, duration: 150, delay: spec.startup });
  }

  private onJumpPressed(): void {
    if (this.phase !== 'playing') return;
    const p = this.player;
    if (p.airborne || p.state === 'hurt' || p.state === 'down' || p.state === 'dead') return;
    p.vz = 560;
    p.z = 1;
    if (p.state !== 'attack') { p.state = 'idle'; }
    audio.jump();
  }

  private togglePause(): void {
    if (this.phase === 'playing') {
      this.phase = 'paused';
      this.showOverlay('Paused / 暂停', 'Press Esc to resume', false);
    } else if (this.phase === 'paused') {
      this.phase = 'playing';
      this.hideOverlay();
    }
  }

  private toggleMute(): void {
    audio.setMuted(!audio.muted);
    this.showBanner(audio.muted ? 'Muted / 静音' : 'Sound on / 声音开', 700);
  }

  // ---------------------------------------------------------- combat
  private specOf(f: Fighter): AttackSpec {
    const s = (f as Fighter & { spec?: AttackSpec }).spec;
    if (s) return s;
    const st = STATS[f.kind];
    return { startup: st.windup, active: 110, recovery: st.recovery, damage: st.damage, reach: st.reach, knockback: 180, knockdown: f.kind === 'boss' };
  }

  private inHitRange(att: Fighter, def: Fighter, spec: AttackSpec): boolean {
    const dx = (def.x - att.x) * att.facing;
    if (dx < -18 || dx > spec.reach + 26) return false;
    if (Math.abs(def.gy - att.gy) > DEPTH_TOLERANCE) return false;
    // Grounded swings whiff under a high jump; air attacks hit grounded foes.
    if (!att.airborne && def.z > 85) return false;
    return true;
  }

  private damageFighter(def: Fighter, att: Fighter | null, dmg: number, knockback: number, knockdown: boolean): void {
    if (!def.alive || def.hp <= 0) return;
    const now = this.time.now;
    if (def.kind === 'player' && now < def.iframesUntil && att) return;
    def.hp = Math.max(0, def.hp - dmg);
    const dir = att ? (def.x >= att.x ? 1 : -1) : 0;
    def.vx = dir * knockback;
    this.spawnHitFx(def.x, def.gy - def.z - 100, dmg);
    if (def.kind === 'player') {
      audio.hurt();
      def.iframesUntil = now + 900;
      this.cameras.main.shake(90, 0.004);
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
      audio.hit();
      this.hitStopUntil = now + 42;
      if (att?.kind === 'player') this.lastAttackHitCount += 1;
      if (def.hp <= 0) {
        def.state = 'down';
        def.stateT = 0;
        this.releaseToken(def);
        audio.death();
        this.kills += 1;
        this.score += STATS[def.kind].score;
        if (def.kind === 'boss') this.onBossDefeated();
      } else if (def.kind !== 'boss' || knockdown) {
        def.state = knockdown ? 'down' : 'hurt';
        def.stateT = 0;
        if (knockdown) { def.vz = 240; def.z = Math.max(def.z, 1); }
        this.releaseToken(def);
      }
    }
    // Flash.
    def.sprite.setTintFill(0xffffff);
    this.time.delayedCall(70, () => {
      if (!def.sprite.active) return;
      def.sprite.clearTint();
      const t = STATS[def.kind].tint;
      if (t) def.sprite.setTint(t);
    });
  }

  private spawnHitFx(x: number, y: number, dmg: number): void {
    const particles = this.add.particles(x, y, 'spark', {
      speed: { min: 60, max: 240 },
      lifespan: 240,
      quantity: 7,
      scale: { start: 1, end: 0 },
      emitting: false,
    });
    particles.setDepth(950);
    particles.explode(7);
    this.time.delayedCall(350, () => particles.destroy());
    const label = this.add.text(x, y - 18, `${dmg}`, { fontSize: '17px', color: '#ffe9a8', fontFamily: 'Georgia, serif', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(960);
    this.tweens.add({ targets: label, y: y - 52, alpha: 0, duration: 550, onComplete: () => label.destroy() });
  }

  // Attacker-token system: at most 2 enemies may be winding up/striking.
  private tokensInUse(): number {
    return this.enemies.filter((e) => e.attackToken).length;
  }
  private tryTakeToken(e: Fighter): boolean {
    if (e.attackToken) return true;
    const limit = e.kind === 'boss' ? 3 : 2;
    if (this.tokensInUse() >= limit) return false;
    e.attackToken = true;
    return true;
  }
  private releaseToken(e: Fighter): void {
    e.attackToken = false;
  }

  // ---------------------------------------------------------- main loop
  update(time: number, deltaMs: number): void {
    if (this.phase === 'paused') return;
    const dt = Math.min(deltaMs, 50) / 1000;
    if (time < this.hitStopUntil && this.phase === 'playing') {
      return; // hit-stop: freeze the world briefly for impact feel
    }
    if (this.phase === 'playing') {
      this.updatePlayer(dt);
      this.updateZones();
      for (const e of this.enemies) this.updateEnemy(e, dt);
    }
    // Airborne + knockback physics for everyone, even during end overlays.
    for (const f of [this.player, ...this.enemies]) this.applyPhysics(f, dt);
    for (const f of [this.player, ...this.enemies]) f.syncVisual();
    this.enemies = this.enemies.filter((e) => e.sprite.active);
    this.updateHud();
  }

  private applyPhysics(f: Fighter, dt: number): void {
    if (f.z > 0 || f.vz > 0) {
      f.z += f.vz * dt;
      f.vz -= GRAVITY * dt;
      if (f.z <= 0) {
        f.z = 0;
        f.vz = 0;
        if (f.state === 'down') {
          // Bounce once, then lie still (handled by state timer).
        }
      }
    }
    if (Math.abs(f.vx) > 1) {
      f.x += f.vx * dt;
      f.vx = Phaser.Math.Linear(f.vx, 0, Math.min(1, dt * 7));
    }
    const bounds = this.movementBounds(f);
    f.x = Phaser.Math.Clamp(f.x, bounds.left, bounds.right);
    f.gy = Phaser.Math.Clamp(f.gy, GROUND_TOP, GROUND_BOT);
    // Down/dead lying tilt.
    const targetAngle = f.state === 'down' && f.z === 0 ? -78 * f.facing : 0;
    f.sprite.angle = Phaser.Math.Linear(f.sprite.angle, targetAngle, 0.25);
  }

  private movementBounds(f: Fighter): { left: number; right: number } {
    if (this.activeZone && f.kind === 'player') {
      return { left: this.activeZone.left + 24, right: this.activeZone.right - 24 };
    }
    // Untriggered next zone acts as the right wall so encounters can't be skipped.
    if (f.kind === 'player') {
      const next = this.zones.find((z) => !z.cleared);
      if (next) return { left: 30, right: next.right - 24 };
    }
    return { left: 30, right: WORLD_W - 30 };
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    if (!p.alive) return;
    p.stateT += dt * 1000;
    const st = STATS.player;

    // i-frame blink.
    if (this.time.now < p.iframesUntil) {
      p.sprite.setAlpha(Math.sin(this.time.now / 35) > 0 ? 0.45 : 0.95);
    } else if (p.sprite.alpha !== 1) {
      p.sprite.setAlpha(1);
    }

    let mx = 0;
    let my = 0;
    if (this.keys.A.isDown || this.cursors.left.isDown) mx -= 1;
    if (this.keys.D.isDown || this.cursors.right.isDown) mx += 1;
    if (this.keys.W.isDown || this.cursors.up.isDown) my -= 1;
    if (this.keys.S.isDown || this.cursors.down.isDown) my += 1;

    if (p.state === 'attack') {
      const spec = this.specOf(p);
      const t = p.stateT;
      const total = spec.startup + spec.active + spec.recovery;
      // Slight forward step during the strike.
      if (t >= spec.startup && t < spec.startup + spec.active) {
        p.x += p.facing * 55 * dt;
        for (const e of this.enemies) {
          if (e.hp > 0 && !p.hitSet.has(e) && this.inHitRange(p, e, spec)) {
            p.hitSet.add(e);
            this.damageFighter(e, p, spec.damage, spec.knockback, spec.knockdown);
          }
        }
      }
      if (t >= total) {
        if (p.comboQueued && p.combo < PLAYER_COMBO.length - 1 && !p.airborne) {
          p.combo += 1;
          this.startPlayerAttack(PLAYER_COMBO[p.combo]);
        } else {
          p.state = 'idle';
          p.combo = 0;
          (p as Fighter & { spec?: AttackSpec }).spec = undefined;
        }
      }
      return;
    }

    if (p.state === 'hurt') {
      if (p.stateT > 240) p.state = 'idle';
      return;
    }
    if (p.state === 'down') {
      if (p.hp > 0 && p.stateT > 750 && p.z === 0) {
        p.state = 'idle';
        p.iframesUntil = this.time.now + 700;
      }
      return;
    }

    if (mx !== 0) p.facing = mx as 1 | -1;
    p.x += mx * st.speed * dt;
    p.gy += my * st.depthSpeed * dt;
    if (mx !== 0 || my !== 0) {
      p.state = 'walk';
      if (!p.airborne) p.play('walk');
      else p.play('idle');
    } else {
      p.state = 'idle';
      p.play('idle');
    }
  }

  private updateZones(): void {
    const p = this.player;
    if (!this.activeZone) {
      const next = this.zones.find((z) => !z.cleared && !z.started);
      if (next && p.x >= next.triggerX) {
        next.started = true;
        this.activeZone = next;
        this.cameras.main.setBounds(next.left, 0, next.right - next.left, VIEW_H);
        for (const s of next.spawns) this.spawnEnemy(s.kind, s.dx, s.gy);
        if (next.isBoss) {
          this.showBanner('Wei Champion / 魏将 现身!', 2200);
          this.bossBarWrap.setVisible(true);
          audio.slam();
        } else {
          this.showBanner(`Wave ${this.zones.indexOf(next) + 1}`, 1200);
        }
      }
    } else if (this.enemies.every((e) => e.hp <= 0 || e.state === 'dead')) {
      const z = this.activeZone;
      z.cleared = true;
      this.activeZone = null;
      this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_H);
      if (!z.isBoss) this.goArrow.setVisible(true);
      this.time.delayedCall(1600, () => this.goArrow.setVisible(false));
    }
    if (this.boss && this.boss.hp > 0 && this.boss.hp <= this.boss.maxHp * 0.5 && !this.boss.bossAddsSpawned) {
      this.boss.bossAddsSpawned = true;
      this.spawnEnemy('blader', this.boss.x - 260, 430);
      this.spawnEnemy('spearman', this.boss.x + 160, 475);
      this.showBanner('Reinforcements!', 1200);
    }
  }

  private spawnEnemy(kind: FighterKind, x: number, gy: number): void {
    const e = new Fighter(this, kind, x, gy);
    e.facing = this.player.x >= x ? 1 : -1;
    e.play('walk');
    e.sprite.setAlpha(0);
    this.tweens.add({ targets: e.sprite, alpha: 1, duration: 300 });
    this.enemies.push(e);
    if (kind === 'boss') this.boss = e;
  }

  private updateEnemy(e: Fighter, dt: number): void {
    if (e.state === 'dead') return;
    e.stateT += dt * 1000;
    const p = this.player;
    const st = STATS[e.kind];

    if (e.state === 'down') {
      if (e.hp <= 0) {
        if (e.stateT > 900) {
          e.state = 'dead';
          this.tweens.add({
            targets: [e.sprite, e.shadow], alpha: 0, duration: 450,
            onComplete: () => e.destroy(),
          });
        }
      } else if (e.stateT > 680 && e.z === 0) {
        e.state = 'idle';
        e.stateT = 0;
      }
      return;
    }
    if (e.state === 'hurt') {
      e.play('idle');
      if (e.stateT > 260) { e.state = 'idle'; e.stateT = 0; }
      return;
    }

    const dx = p.x - e.x;
    e.facing = dx >= 0 ? 1 : -1;
    const distX = Math.abs(dx);
    const distY = Math.abs(p.gy - e.gy);

    // The attack animation itself contains the wind-up (weapon raise), so
    // the whole swing is one state: the anim is time-scaled so its visible
    // strike frame coincides with atkStrikeAt (= this kind's windup time).
    if (e.state === 'attack') {
      const activeLen = 130;
      if (e.stateT < e.atkStrikeAt) {
        // Telegraph emphasis while the weapon rises.
        if (e.kind === 'boss') {
          e.sprite.setTint(Math.sin(this.time.now / 40) > 0 ? 0xffa292 : 0xffffff);
        }
      } else {
        if (e.kind === 'boss' && e.sprite.tintTopLeft !== 0xffffff) e.sprite.clearTint();
        if (e.stateT < e.atkStrikeAt + activeLen) {
          e.x += e.facing * 30 * dt; // strike step-in
          const spec = this.specOf(e);
          if (p.hp > 0 && !e.hitSet.has(p) && this.inHitRange(e, p, spec)) {
            e.hitSet.add(p);
            this.damageFighter(p, e, spec.damage, spec.knockback, spec.knockdown);
            if (e.kind === 'boss') { audio.slam(); this.cameras.main.shake(140, 0.006); }
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

    // Positioning AI (idle/walk).
    const preferred = e.kind === 'boss' ? 105 : e.kind === 'spearman' ? 82 : 60;
    const inLane = distY <= DEPTH_TOLERANCE - 6;
    if (!inLane || distX > preferred + 12) {
      const sp = st.speed * (e.kind === 'boss' && e.hp < e.maxHp * 0.4 ? 1.45 : 1);
      if (distX > 8) e.x += Math.sign(dx) * sp * dt;
      if (!inLane) e.gy += Math.sign(p.gy - e.gy) * st.depthSpeed * dt;
      e.state = 'walk';
      e.play('walk');
    } else {
      e.state = 'idle';
      e.play('idle');
      // Circle-strafe in depth while waiting for a token.
      e.thinkT += dt * 1000;
      if (e.thinkT > 700) { e.thinkT = 0; e.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      e.gy += e.strafeDir * st.depthSpeed * 0.45 * dt;
      if (distX <= st.reach + 18 && inLane && p.hp > 0 && this.tryTakeToken(e)) {
        e.state = 'attack';
        e.stateT = 0;
        e.hitSet.clear();
        e.atkStrikeAt = st.windup;
        e.atkTotal = Math.round(st.windup / Fighter.strikeFrac(e.kind)) + 160;
        e.play('attack', e.atkTotal);
        audio.swing();
      }
    }
  }

  private updateHud(): void {
    const p = this.player;
    this.hpBar.width = 222 * Phaser.Math.Clamp(p.hp / p.maxHp, 0, 1);
    this.hpBar.setFillStyle(p.hp / p.maxHp > 0.3 ? 0x3fae5a : 0xc03a28);
    this.scoreLabel.setText(`Score ${this.score}`);
    const remaining = this.enemies.filter((e) => e.hp > 0).length;
    if (this.activeZone) {
      const idx = this.zones.indexOf(this.activeZone);
      this.waveLabel.setText(
        this.activeZone.isBoss ? '— Final duel —' : `Wave ${idx + 1} · Enemies left: ${remaining}`,
      );
    } else if (this.phase === 'playing') {
      this.waveLabel.setText(this.zones.every((z) => z.cleared) ? '' : 'Advance →');
    }
    if (this.boss && this.bossBarWrap.visible) {
      this.bossBar.width = 458 * Phaser.Math.Clamp(this.boss.hp / this.boss.maxHp, 0, 1);
      if (this.boss.hp <= 0) this.bossBarWrap.setVisible(false);
    }
  }

  // ---------------------------------------------------------- endings
  private onBossDefeated(): void {
    this.time.delayedCall(1200, () => {
      if (this.phase !== 'playing') return;
      this.phase = 'won';
      const secs = Math.round((this.time.now - this.startTime) / 1000);
      audio.jingle(true);
      this.showOverlay(
        'VICTORY / 胜利',
        `The camp is yours, Guan Yu / 关羽 prevails!\nScore ${this.score} · Foes defeated ${this.kills} · Time ${secs}s\n\nPress R or Enter to play again`,
        true,
      );
    });
  }

  private onPlayerDefeated(): void {
    audio.death();
    this.time.delayedCall(1300, () => {
      if (this.phase !== 'playing') return;
      this.phase = 'lost';
      audio.jingle(false);
      this.showOverlay(
        'GAME OVER / 战败',
        `Guan Yu / 关羽 has fallen…\nScore ${this.score} · Foes defeated ${this.kills}\n\nPress R or Enter to try again`,
        true,
      );
    });
  }

  private showOverlay(title: string, body: string, withRestart: boolean): void {
    this.hideOverlay();
    const c = this.add.container(VIEW_W / 2, VIEW_H / 2).setScrollFactor(0).setDepth(2000);
    const bg = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.62);
    const panel = this.add.rectangle(0, 0, 560, 280, 0x1d150d, 0.95).setStrokeStyle(2, 0xc8a24a);
    const t = this.add.text(0, -95, title, { fontFamily: 'Georgia, serif', fontSize: '38px', color: '#f0d492' }).setOrigin(0.5);
    const b = this.add.text(0, 6, body, { fontFamily: 'Georgia, serif', fontSize: '18px', color: '#e8e0c8', align: 'center', lineSpacing: 8 }).setOrigin(0.5);
    c.add([bg, panel, t, b]);
    if (withRestart) {
      const btn = this.add.text(0, 100, '↻ Restart (R)', { fontFamily: 'Georgia, serif', fontSize: '20px', color: '#ffd76a' }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      btn.once('pointerdown', () => this.scene.restart());
      c.add(btn);
    }
    this.overlay = c;
  }

  private hideOverlay(): void {
    this.overlay?.destroy();
    this.overlay = null;
  }
}

const AirAttackShim: AttackSpec = AIR_ATTACK;
