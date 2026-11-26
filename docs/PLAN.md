# Red Cliffs Ablaze — implementation notes

Extends the shipped Dynasty Wars demo (baseline documented in
`docs/RED_CLIFFS_BASELINE.md`: main @ 8dcc252, 26/26 browser checks before
the refactor) into the full single-stage arcade game of issue #3. The
existing Phaser renderer, approved realistic art and controls are retained.

## Structure
- Fixed 60 Hz simulation step; rendering/HUD are read-only views of sim
  state. Seeded encounter selection, per-move timing tables and authored
  section data live in `src/data.ts`; the scene (`src/game.ts`) only
  executes them.
- Stage: 6,200px world — Prow, Gangplank (narrow depth band over water),
  Archer Deck, Burning Deck (fire patches + falling mast), Flagship
  Foredeck, Command Deck (Yu Jin). Camera-lock encounters with sequential
  waves, visible edge entries, spawn grace, GO arrow on clear.
- Combat budgets: at most 2 melee + 1 ranged attackers (boss included);
  no new attacks against a downed player; wake-up i-frames; per-swing hit
  registration once per target; armored wind-ups only broken by heavy hits.
- Replay: fixed Arcade (`variants[0]`), seeded Remix re-picking authored
  variants for decks 2–5 only; score events with anti-farm caps; medals;
  checkpoint snapshots so continues cannot duplicate points; records in
  `src/records.ts` with a session fallback.

## Media workflow (as executed)
- Kept: Guan Yu / spearman (soldier) / Yu Jin (boss) existing sprite sets.
- New images (gpt-image-2): sword soldier, archer and brute masters;
  fleet and flagship background panoramas.
- New motion (grok-imagine-video-1.5 via the local file helper): idle /
  walk / attack for the three new enemies, plus Guan Yu's throw — the M1
  gate, with grip point + release tick measured into the manifest (see
  `assets-source/guanyu/provenance-throw.json`). Two throw attempts were
  generated; attempt 1 was used (attempt 2's weapon vanished mid-heave).
- Shared pipeline per character: extract 12 fps → magenta chroma-key →
  despill → one global scale/translation onto a 512px canvas, ground 472 →
  contact-sheet inspection. Per-character `normalize.py` + `provenance.json`
  record scale caps, strike fractions and honest quality gaps (e.g. the
  brute is ~308px tall on canvas because his raised club caps the scale).
- Moves without dedicated clips reuse validated art with code-driven
  timing/FX (dash, air variants, Dragon Cleave sweep, boss charge/leap):
  every action has a readable impact pose from its source clip, and the
  gaps are listed in `docs/TEST_REPORT.md`.

## Verification
`npm run build` + `node scripts/verify-browser.mjs` (47 browser checks,
screenshots at two viewports) — details and remaining gaps in
`docs/TEST_REPORT.md`.
