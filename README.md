# Red Cliffs Ablaze · 赤壁烽火 — Guan Yu / 关羽

A single-player, side-scrolling browser beat-'em-up inspired by
*Warriors of Fate / Tenchi wo Kurau II* (吞食天地2：赤壁之战). Play Guan Yu
across the burning, chained Wei fleet at Red Cliffs: five combat decks,
one boss arena, roughly forty enemies, and **Yu Jin / 于禁** waiting on the
command deck. Original artwork and code; no assets from the arcade game.

## Play

| Action | Keys |
|---|---|
| Move (including depth lanes) | `WASD` or Arrow keys |
| Attack — 4-hit chain on a confirmed hit | `J` (jab · slash · rising slash · heavy knockdown) |
| Grab (point-blank) · pummel ×3 · throw | `J` close · `J` · `Direction+J` |
| Jump · air attacks | `K` · `J` in air (neutral chop / moving slash) |
| Dash · dash attack | double-tap `←`/`→` · `J` while dashing |
| Dragon Cleave / 青龙斩 | `J+K` together — invulnerable sweep, costs 8 HP on a hit (never below 1 HP) |
| Confirm / Pause / Mute | `Enter` · `P` or `Esc` (shows the move list) · `M` |

Attacks only connect in roughly the same ground lane — watch the shadows.
Brutes shrug off light hits while winding up and cannot be thrown; bait
the heavy swing and punish the recovery. Oil barrels explode for anyone
near them — including you. Food is only eaten while hurt, so a visible
heal can be saved for later in the deck.

### Runs, score and medals

- **Arcade** is the fixed, learnable stage. Clearing it unlocks the results
  options **Retry Arcade / Play Remix / Title**.
- **Remix** re-authors decks 2–5 from a shown seed (lane, entry order,
  formation, prop positions). **Retry This Seed** replays the identical
  arrangement; **New Seed** deals another.
- Score rewards defeats and skill events (throw-into-ranks, multi-enemy
  barrel hits, clean boss punishes — all capped against farming), plus a
  victory time bonus. Results show the breakdown, best combo, clear time,
  continues, rank (S/A/B/C/D) with the next-rank target, and personal best.
- Three mastery medals: **Line Breaker** (one throw hits two others),
  **Deck Tactician** (one barrel defeats two), **Steady Nerve** (beat
  Yu Jin untouched on the command deck).
- A **continue** restores the current deck with a fresh life and the score
  you entered it with; continued Arcade runs are not ranked. Mute, medals
  and bests (Arcade separate from per-seed Remix) persist in `localStorage`
  when available and otherwise last for the session.

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
title → ready → move/combo/grab/throw/Dragon-Cleave/dash/jump, depth-lane
miss, damage-once-per-swing, pause, all five decks, barrel medal, falling
mast, Yu Jin's phases/patterns/single reinforcement call, defeat →
continue score restoration, victory/rank, Remix seed repeatability and
difference, records persistence across reload, restart, and a second
viewport. See `docs/TEST_REPORT.md` for the latest run.

## Project layout

- `src/main.ts` — boot/asset loading, title & ready (move list) screens
- `src/game.ts` — stage simulation, combat, enemy/boss AI, HUD, results
- `src/data.ts` — move tables, enemy stats, authored sections/variants,
  score/rank math, seeded RNG
- `src/records.ts` — mute/medals/personal bests (localStorage + fallback)
- `src/audio.ts` — procedural Web Audio music & SFX (no audio files)
- `public/assets/` — finished sprite frames + manifests, backgrounds
- `assets-source/` — editable source media, generation provenance,
  reproducible processing scripts (`normalize.py`, `finalize-throw.py`)
- `docs/RED_CLIFFS_BASELINE.md` — M0 baseline & coverage inventory
- `docs/TEST_REPORT.md` — what was played/verified, remaining gaps
- `scripts/verify-browser.mjs` — automated browser verification

## Asset provenance & license notes

All artwork is original, AI-generated during development (images:
GPT Image 2; motion clips: Grok Imagine Video 1.5 image-to-video from
approved character masters — per-asset prompts, models, attempts and
processing steps are in `assets-source/*/provenance*.json`). Frames were
extracted from the clips, chroma-keyed, selected/retimed and normalized
onto shared canvases with a fixed ground line; combat timing, hitboxes,
grip/release points and strike fractions are declared in code/manifests,
never driven by the art. Music and SFX are synthesized in `src/audio.ts`.

The shipped game is a static bundle of finished assets: it performs no
runtime AI calls and needs no API keys or accounts.
