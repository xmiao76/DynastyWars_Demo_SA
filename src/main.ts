import Phaser from 'phaser';
import { audio } from './audio';
import { GameScene } from './game';
import { records } from './records';

export const VIEW_W = 960;
export const VIEW_H = 540;

export interface CharManifest {
  canvas: [number, number];
  groundY: number;
  /** Canvas x of the character's feet/body center (sprites face right,
   *  weapons extend right, so this is left of canvas center). */
  originX?: number;
  actions: Record<string, number>;
  /** Fraction of a one-shot animation where its visible strike lands. */
  strikeFrac?: Record<string, number>;
  /** Guan Yu throw grip point, canvas px relative to (originX, groundY). */
  grip?: { dx: number; dy: number };
  throwReleaseIndex?: number;
}

export const CHARACTERS = ['guanyu', 'soldier', 'sword', 'archer', 'brute', 'boss'] as const;
export type CharId = (typeof CHARACTERS)[number];

export const manifests: Partial<Record<CharId, CharManifest>> = {};
export const missingAssets: string[] = [];

// Run configuration shared between title / ready / game via these exports
// (scene restarts re-read them; the registry would need the same care).
export const runConfig: { mode: 'arcade' | 'remix'; seed: number } = { mode: 'arcade', seed: 0 };

declare global {
  interface Window {
    __DYNASTY_MISSING__?: string[];
  }
}
window.__DYNASTY_MISSING__ = missingAssets;

function makeFallbackTexture(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  color: number,
): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(color, 1);
  g.fillRoundedRect(w * 0.3, h * 0.25, w * 0.4, h * 0.68, 12);
  g.fillStyle(0xf2d8a7, 1);
  g.fillCircle(w * 0.5, h * 0.2, w * 0.11);
  g.lineStyle(6, 0xd9d9d9, 1);
  g.lineBetween(w * 0.62, h * 0.42, w * 0.92, h * 0.16);
  g.generateTexture(key, w, h);
  g.destroy();
}

export function frameKey(char: string, action: string, i: number): string {
  return `${char}-${action}-${i}`;
}

export const MOVE_LIST_LINES = [
  'Move  WASD / Arrows — fight in your ground lane (watch shadows)',
  'J  Attack — 4-hit chain on a confirmed hit (jab · slash · rising slash · heavy knockdown)',
  'J at point-blank  Grab a soldier · J pummels (×3) · Direction+J throws him into his ranks',
  'K  Jump · J in air: neutral chop / moving slash',
  'Double-tap ←/→  Dash · J during dash: dash attack (knockdown)',
  'J+K together  Dragon Cleave / 青龙斩 — invulnerable sweep, costs 8 HP on a hit (never below 1 HP)',
  'P / Esc  Pause · M  Mute · Enter  Confirm',
  'Break crates, eat buns & chicken, beware oil barrels — they burn you too.',
];

class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  preload(): void {
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      missingAssets.push(file.src ?? file.key);
    });
    // Manifests are fetched (not loaded via Phaser's JSON loader) so that a
    // static host's SPA-fallback HTML for a missing file cannot throw a
    // JSON parse error; failures simply fall back to placeholder textures.
    this.load.image('bg-fleet', 'assets/bg/fleet.jpg');
    this.load.image('bg-flagship', 'assets/bg/flagship.jpg');
  }

  async create(): Promise<void> {
    const status = this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 30, 'Loading…', {
        fontFamily: 'Georgia, serif',
        fontSize: '28px',
        color: '#e8d9b0',
      })
      .setOrigin(0.5);
    const bar = this.add
      .rectangle(VIEW_W / 2 - 210, VIEW_H / 2 + 16, 0, 10, 0xc8a24a)
      .setOrigin(0, 0.5);
    this.add.rectangle(VIEW_W / 2, VIEW_H / 2 + 16, 420, 14, 0x333333).setOrigin(0.5).setDepth(-1);

    // Fetch manifests, then queue all sprite frames they list.
    for (const c of CHARACTERS) {
      let m: CharManifest | undefined;
      try {
        const res = await fetch(`assets/frames/${c}/manifest.json`);
        if (res.ok) m = (await res.json()) as CharManifest;
      } catch {
        m = undefined;
      }
      if (!m || !m.actions) {
        missingAssets.push(`assets/frames/${c}/manifest.json`);
        continue;
      }
      manifests[c] = m;
      for (const [action, count] of Object.entries(m.actions)) {
        for (let i = 0; i < count; i += 1) {
          this.load.image(frameKey(c, action, i), `assets/frames/${c}/${action}_${i}.png`);
        }
      }
    }

    this.load.on('progress', (v: number) => {
      bar.width = 420 * v;
    });
    this.load.once('complete', () => {
      this.buildAnimations();
      status.setText('Ready');
      audio.setMuted(records.muted);
      this.scene.start('title');
    });
    this.load.start();
  }

  private buildAnimations(): void {
    const fallbackColors: Record<string, number> = {
      guanyu: 0x1e6b3a,
      soldier: 0x3a4a66,
      sword: 0x6b3a2a,
      archer: 0x2a5a5a,
      brute: 0x5a4028,
      boss: 0x6b1e1e,
    };
    const frameRates: Record<string, number> = { idle: 6, walk: 10, attack: 14, throw: 12 };
    for (const c of CHARACTERS) {
      const m = manifests[c];
      const canvas: [number, number] = m?.canvas ?? [512, 512];
      const actions = m?.actions ?? {};
      const names = new Set(['idle', 'walk', 'attack', ...Object.keys(actions)]);
      for (const action of names) {
        const count = actions[action] ?? 0;
        const frames: { key: string }[] = [];
        for (let i = 0; i < count; i += 1) {
          const key = frameKey(c, action, i);
          if (this.textures.exists(key)) frames.push({ key });
        }
        if (frames.length === 0) {
          if (action !== 'idle' && action !== 'walk' && action !== 'attack') continue;
          const key = `${c}-fallback`;
          makeFallbackTexture(this, key, canvas[0], canvas[1], fallbackColors[c] ?? 0x555555);
          frames.push({ key });
          if (count === 0) missingAssets.push(`${c}/${action}`);
        }
        this.anims.create({
          key: `${c}-${action}`,
          frames,
          frameRate: frameRates[action] ?? 12,
          repeat: action === 'idle' || action === 'walk' ? -1 : 0,
        });
      }
    }
    for (const key of ['bg-fleet', 'bg-flagship']) {
      if (!this.textures.exists(key)) {
        const g = this.make.graphics({ x: 0, y: 0 }, false);
        g.fillGradientStyle(0x1a2438, 0x1a2438, 0x7a3a18, 0x7a3a18, 1);
        g.fillRect(0, 0, 960, 400);
        g.fillStyle(0x6b4a2c, 1);
        g.fillRect(0, 400, 960, 140);
        g.generateTexture(key, 960, 540);
        g.destroy();
        missingAssets.push(key);
      }
    }
  }
}

function heroSprite(scene: Phaser.Scene, x: number, y: number, displayH: number): Phaser.GameObjects.Sprite {
  const m = manifests.guanyu;
  const heroKey = scene.textures.exists(frameKey('guanyu', 'idle', 0))
    ? frameKey('guanyu', 'idle', 0)
    : 'guanyu-fallback';
  const hero = scene.add.sprite(x, y, heroKey);
  if (m) hero.setOrigin((m.originX ?? m.canvas[0] / 2) / m.canvas[0], m.groundY / m.canvas[1]);
  hero.setDisplaySize(displayH * ((m?.canvas[0] ?? 512) / (m?.canvas[1] ?? 512)), displayH);
  if (scene.anims.exists('guanyu-idle')) hero.play('guanyu-idle');
  return hero;
}

class TitleScene extends Phaser.Scene {
  constructor() {
    super('title');
  }

  create(): void {
    const bg = this.add.image(VIEW_W / 2, VIEW_H / 2, 'bg-fleet');
    bg.setDisplaySize(VIEW_W, VIEW_H);
    this.add.rectangle(VIEW_W / 2, VIEW_H / 2, VIEW_W, VIEW_H, 0x000000, 0.42);

    this.add
      .text(VIEW_W / 2, 92, 'RED CLIFFS ABLAZE', {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: '58px',
        color: '#f0d492',
        stroke: '#4a1808',
        strokeThickness: 7,
      })
      .setOrigin(0.5);
    this.add
      .text(VIEW_W / 2, 140, '赤壁烽火 · One hero. One burning fleet.', {
        fontFamily: 'Georgia, serif',
        fontSize: '23px',
        color: '#ffd9a8',
      })
      .setOrigin(0.5);

    heroSprite(this, VIEW_W / 2, 452, 265);

    this.add
      .text(
        VIEW_W / 2,
        188,
        'Fight across the chained ships at Red Cliffs and face Yu Jin / 于禁 on the command deck.\nArcade: the fixed, learnable stage. Clear it to unlock seeded Remix runs.',
        { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#e2d7ba', align: 'center', lineSpacing: 7 },
      )
      .setOrigin(0.5, 0);

    const best = records.arcadeBest();
    if (best) {
      this.add
        .text(VIEW_W / 2, 252, `Arcade best: ${best.score} pts · Rank ${best.rank} · ${best.timeSec}s`, {
          fontFamily: 'Georgia, serif', fontSize: '15px', color: '#cbbd96',
        })
        .setOrigin(0.5);
    }
    const medals = records.medals();
    if (medals.length > 0) {
      this.add
        .text(VIEW_W / 2, 274, `Medals earned: ${medals.length} / 3`, {
          fontFamily: 'Georgia, serif', fontSize: '15px', color: '#cbbd96',
        })
        .setOrigin(0.5);
    }

    const start = this.add
      .text(VIEW_W / 2, 488, '▶  Press ENTER or click to muster', {
        fontFamily: 'Georgia, serif',
        fontSize: '24px',
        color: '#ffd76a',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.tweens.add({ targets: start, alpha: 0.35, duration: 650, yoyo: true, repeat: -1 });

    if (missingAssets.length > 0) {
      this.add
        .text(VIEW_W / 2, 518, `Note: ${missingAssets.length} asset(s) missing — placeholders in use.`, {
          fontSize: '13px', color: '#ff9a8a', fontFamily: 'monospace',
        })
        .setOrigin(0.5);
    }

    const begin = (): void => {
      // Title always musters for the fixed Arcade run; Remix is entered from
      // the results screen (or replays its seed directly into the game).
      runConfig.mode = 'arcade';
      runConfig.seed = 0;
      audio.start();
      audio.ui();
      this.scene.start('ready');
    };
    start.once('pointerdown', begin);
    this.input.keyboard?.once('keydown-ENTER', begin);
    this.input.keyboard?.once('keydown-SPACE', begin);
  }
}

class ReadyScene extends Phaser.Scene {
  constructor() {
    super('ready');
  }

  create(): void {
    const bg = this.add.image(VIEW_W / 2, VIEW_H / 2, 'bg-flagship');
    bg.setDisplaySize(VIEW_W, VIEW_H);
    this.add.rectangle(VIEW_W / 2, VIEW_H / 2, VIEW_W, VIEW_H, 0x000000, 0.55);

    const modeLabel = runConfig.mode === 'remix' ? `REMIX · Seed ${runConfig.seed}` : 'ARCADE';
    this.add
      .text(VIEW_W / 2, 48, `${modeLabel} — Muster / 出战`, {
        fontFamily: 'Georgia, serif', fontSize: '30px', color: '#f0d492', stroke: '#2a1a08', strokeThickness: 4,
      })
      .setOrigin(0.5);

    heroSprite(this, 215, 430, 300);
    this.add
      .text(215, 446, 'Guan Yu / 关羽', { fontFamily: 'Georgia, serif', fontSize: '22px', color: '#f0d492' })
      .setOrigin(0.5, 0);
    this.add
      .text(215, 474, 'Green Dragon Crescent Blade\n青龙偃月刀', {
        fontFamily: 'Georgia, serif', fontSize: '14px', color: '#cbbd96', align: 'center',
      })
      .setOrigin(0.5, 0);

    const panel = this.add.rectangle(624, 270, 616, 330, 0x14100b, 0.82).setStrokeStyle(1, 0x8a6f3a);
    void panel;
    this.add
      .text(332, 122, MOVE_LIST_LINES.join('\n'), {
        fontFamily: 'Georgia, serif', fontSize: '13px', color: '#e8e0c8', lineSpacing: 10,
      })
      .setOrigin(0, 0);

    const start = this.add
      .text(VIEW_W / 2, 502, 'Press ENTER to board the fleet', {
        fontFamily: 'Georgia, serif', fontSize: '22px', color: '#ffd76a', stroke: '#000', strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.tweens.add({ targets: start, alpha: 0.4, duration: 600, yoyo: true, repeat: -1 });

    const begin = (): void => {
      audio.start();
      audio.ui();
      this.scene.start('game');
    };
    start.once('pointerdown', begin);
    this.input.keyboard?.once('keydown-ENTER', begin);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: VIEW_W,
  height: VIEW_H,
  backgroundColor: '#14100c',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true },
  scene: [BootScene, TitleScene, ReadyScene, GameScene],
});
