# Dynasty Wars Demo — Guan Yu / 关羽

A single-player, side-scrolling browser beat-'em-up demo inspired by
*Warriors of Fate / Tenchi wo Kurau II* (吞食天地2：赤壁之战). Play Guan Yu
through one complete stage: three enemy waves on a Three Kingdoms
battlefield, then a final duel with a Wei champion at the enemy camp.
Original artwork and code; no assets from the original arcade game.

## Play

| Action | Keys |
|---|---|
| Move (incl. depth lanes) | `WASD` or Arrow keys |
| Attack (tap repeatedly for a 3-hit combo) | `J` |
| Jump | `K` |
| Jump attack | `J` while airborne |
| Pause / resume | `Esc` |
| Mute / unmute | `M` |
| Restart (on victory / game-over screens) | `R` or `Enter` |

Attacks only connect with enemies in roughly the same ground lane — watch
the shadows to line up your guandao. The boss telegraphs his overhead chop;
strike during his long recovery.

## Run locally

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Production build (static output in `dist/`):

```bash
npm run build
npm run preview    # http://127.0.0.1:4173
```

## Deploy to Cloudflare Pages (manual)

1. `npm run build`
2. In Cloudflare Pages, create a project from this repository (or use
   `npx wrangler pages deploy dist`).
3. Build command: `npm run build` · Output directory: `dist`.
4. No environment variables, functions, or backend are required — the game
   is fully static and makes no runtime AI/API calls.

## Verification

```bash
npm run build
node scripts/verify-browser.mjs   # screenshots + report in ./verification
```

The script drives the built game in headless Chromium (Playwright):
title → start → movement, combo damage-once-per-swing, depth-lane miss,
jump/air attack, pause, mute, wave clear, boss victory, game over, and
restart. It needs Playwright available locally (see the header comment in
the script for how the module is resolved).

## Project layout

- `src/main.ts` — boot/asset loading, title screen, Phaser config
- `src/game.ts` — stage, combat system, enemy/boss AI, HUD, endings
- `src/audio.ts` — procedural Web Audio music & SFX (no audio files)
- `public/assets/` — finished sprites (transparent PNG frames + manifests),
  backgrounds
- `assets-source/` — editable source media, generation provenance,
  reproducible processing scripts
- `docs/PLAN.md` — implementation plan & media-capability summary
- `scripts/verify-browser.mjs` — automated browser verification

## Asset provenance & license notes

All character and background artwork is original, AI-generated during
development (images: GPT Image 2; motion clips: Grok Imagine Video 1.5 —
per-asset prompts, models, attempts and processing steps are recorded in
`assets-source/*/provenance.json`). Frames were extracted from the clips,
chroma-keyed, selected/retimed, and normalized onto shared canvases with a
fixed ground line; the processing scripts live beside the source media so
the pipeline is reproducible. Music and sound effects are synthesized in
code (`src/audio.ts`) — no third-party audio is used. No artwork, sprites,
or audio from the original arcade game is included.

The shipped game is a static bundle of finished assets: it performs no
runtime AI calls and needs no API keys or accounts.
