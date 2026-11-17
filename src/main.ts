import Phaser from 'phaser';
import { audio } from './audio';
import { GameScene } from './game';

export const VIEW_W = 960;
export const VIEW_H = 540;

export interface CharManifest {
  canvas: [number, number];
  groundY: number;
  /** Canvas x of the character's feet/body center (sprites face right,
   *  weapons extend right, so this is left of canvas center). */
  originX?: number;
  actions: Record<string, number>;
}

export const CHARACTERS = ['guanyu', 'soldier', 'boss'] as const;
export type CharId = (typeof CHARACTERS)[number];

export const manifests: Partial<Record<CharId, CharManifest>> = {};
export const missingAssets: string[] = [];

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
  label: string,
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
  void label;
}

export function frameKey(char: string, action: string, i: number): string {
  return `${char}-${action}-${i}`;
}

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
    this.load.image('bg-battlefield', 'assets/bg/battlefield.jpg');
    this.load.image('bg-camp', 'assets/bg/camp.jpg');
  }

  async create(): Promise<void> {
    const status = this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 30, 'Loading…', {
        fontFamily: 'Georgia, serif',
        fontSize: '28px',
        color: '#e8d9b0',
      })
      .setOrigin(0.5);
    const barBg = this.add
      .rectangle(VIEW_W / 2, VIEW_H / 2 + 16, 420, 14, 0x333333)
      .setOrigin(0.5);
    const bar = this.add
      .rectangle(VIEW_W / 2 - 210, VIEW_H / 2 + 16, 0, 10, 0xc8a24a)
      .setOrigin(0, 0.5);
    void barBg;

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
          this.load.image(
            frameKey(c, action, i),
            `assets/frames/${c}/${action}_${i}.png`,
          );
        }
      }
    }

    this.load.on('progress', (v: number) => {
      bar.width = 420 * v;
    });
    this.load.once('complete', () => {
      this.buildAnimations();
      status.setText('Ready');
      this.scene.start('title');
    });
    this.load.start();
  }

  private buildAnimations(): void {
    const fallbackColors: Record<string, number> = {
      guanyu: 0x1e6b3a,
      soldier: 0x3a4a66,
      boss: 0x6b1e1e,
    };
    for (const c of CHARACTERS) {
      const m = manifests[c];
      const canvas: [number, number] = m?.canvas ?? [512, 512];
      const actions = m?.actions ?? {};
      for (const action of ['idle', 'walk', 'attack']) {
        const count = actions[action] ?? 0;
        const frames: { key: string }[] = [];
        for (let i = 0; i < count; i += 1) {
          const key = frameKey(c, action, i);
          if (this.textures.exists(key)) frames.push({ key });
        }
        if (frames.length === 0) {
          const key = `${c}-fallback`;
          makeFallbackTexture(this, key, canvas[0], canvas[1], fallbackColors[c] ?? 0x555555, c);
          frames.push({ key });
          if (count === 0) missingAssets.push(`${c}/${action}`);
        }
        const frameRate =
          action === 'idle' ? 6 : action === 'walk' ? 10 : 14;
        this.anims.create({
          key: `${c}-${action}`,
          frames,
          frameRate,
          repeat: action === 'attack' ? 0 : -1,
        });
      }
    }
    if (!this.textures.exists('bg-battlefield')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillGradientStyle(0x87a8c8, 0x87a8c8, 0xd8b98a, 0xd8b98a, 1);
      g.fillRect(0, 0, 960, 400);
      g.fillStyle(0x8a6f4d, 1);
      g.fillRect(0, 400, 960, 140);
      g.generateTexture('bg-battlefield', 960, 540);
      g.destroy();
    }
  }
}

class TitleScene extends Phaser.Scene {
  constructor() {
    super('title');
  }

  create(): void {
    const bg = this.add.image(VIEW_W / 2, VIEW_H / 2, 'bg-battlefield');
    bg.setDisplaySize(VIEW_W, VIEW_H);
    this.add.rectangle(VIEW_W / 2, VIEW_H / 2, VIEW_W, VIEW_H, 0x000000, 0.45);

    this.add
      .text(VIEW_W / 2, 105, 'DYNASTY WARS', {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: '64px',
        color: '#f0d492',
        stroke: '#4a2f10',
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    this.add
      .text(VIEW_W / 2, 152, '赤壁前哨 · Demo — Guan Yu / 关羽', {
        fontFamily: 'Georgia, serif',
        fontSize: '24px',
        color: '#e8e0c8',
      })
      .setOrigin(0.5);

    // Hero showcase (idle animation if available).
    const m = manifests.guanyu;
    const heroKey = this.textures.exists(frameKey('guanyu', 'idle', 0))
      ? frameKey('guanyu', 'idle', 0)
      : 'guanyu-fallback';
    const hero = this.add.sprite(VIEW_W / 2, 430, heroKey);
    if (m) hero.setOrigin((m.originX ?? m.canvas[0] / 2) / m.canvas[0], m.groundY / m.canvas[1]);
    hero.setDisplaySize(
      270 * ((m?.canvas[0] ?? 512) / (m?.canvas[1] ?? 512)),
      270,
    );
    if (this.anims.exists('guanyu-idle')) hero.play('guanyu-idle');

    const controls = [
      'Move: WASD / Arrow keys      Attack: J (×3 combo)      Jump: K',
      'Air attack: J while airborne      Pause: Esc      Mute: M',
      '',
      'Fight through the Wei vanguard and defeat their champion!',
    ];
    this.add
      .text(VIEW_W / 2, 220, controls.join('\n'), {
        fontFamily: 'Georgia, serif',
        fontSize: '17px',
        color: '#d8cfb4',
        align: 'center',
        lineSpacing: 7,
      })
      .setOrigin(0.5, 0);

    const start = this.add
      .text(VIEW_W / 2, 475, '▶  Press ENTER or click to start', {
        fontFamily: 'Georgia, serif',
        fontSize: '24px',
        color: '#ffd76a',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.tweens.add({
      targets: start,
      alpha: 0.35,
      duration: 650,
      yoyo: true,
      repeat: -1,
    });

    if (missingAssets.length > 0) {
      this.add
        .text(
          VIEW_W / 2,
          515,
          `Note: ${missingAssets.length} asset(s) missing — placeholders in use.`,
          { fontSize: '13px', color: '#ff9a8a', fontFamily: 'monospace' },
        )
        .setOrigin(0.5);
    }

    const begin = (): void => {
      audio.start();
      audio.ui();
      this.scene.start('game');
    };
    start.once('pointerdown', begin);
    this.input.keyboard?.once('keydown-ENTER', begin);
    this.input.keyboard?.once('keydown-SPACE', begin);
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
  scene: [BootScene, TitleScene, GameScene],
});
