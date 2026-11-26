# Red Cliffs Ablaze — M0 baseline & coverage inventory

Baseline: `main` at 8dcc252 (merge of PR #2), the shipped Dynasty Wars demo.
Baseline build verified 2026-11-25: `npm run build` OK;
`node scripts/verify-browser.mjs verification-baseline` → **26/26 checks
passed**. Baseline captures: `verification-baseline/` (title, start, attack,
jump-attack, walk, pause, boss, victory, game over) — local verification
output, not shipped. PR Before images are the matched baseline captures
re-saved into `docs/screenshots/before-*`.

## Hero as approved (starting point, retained)
- Guan Yu master: `assets-source/guanyu/master.png` (green robe, gold dragon
  armor, long beard, guandao diagonal ready stance, magenta). In-game:
  `public/assets/frames/guanyu/` idle×8 (6 fps loop), walk×8 (10 fps),
  attack×9 (one-shot, time-scaled per combo step; visible strike ≈55%).
  Display: 275px canvas height in a 960×540 view; ground band y 398–498.
- Controls (baseline): WASD/arrows belt movement, J attack (3-hit combo,
  chain on queued press), K jump, J air attack, Esc pause, M mute,
  R/Enter restart on end screens. Representative fight: wave 1 = 2 spearmen;
  a single swing deals 8 dmg once per enemy (verified), depth-lane tolerance
  30px makes off-lane swings whiff (verified).
- Enemies (baseline): spearman + blader both reuse the `soldier` sprite
  (visually a spearman); boss `boss` sprite (heavy sabre champion).
  Attacker tokens cap simultaneous attackers at 2. Boss spawns 2 adds at 50%.

## Coverage vs issue #3 (what is missing)
| Brief item | Baseline | Action |
|---|---|---|
| 6 sections / ~40 foes / locks / GO | 3 waves + boss, 13 foes | New stage data: Prow, Gangplank, Archer deck, Burning deck, Foredeck, Command deck |
| 4-hit combo, dash, dash atk, jump atks | 3-hit, jump atk | Extend move table |
| Grab / pummel / throw (+ victim sync) | none | New; throw = first new video-derived action (M1 gate) |
| Dragon Cleave J+K (HP cost, i-frames) | none | New; chord resolved before J/K singly |
| Sword / Spear / Archer / Brute roles | spear sprite only | Sword=NEW char, Spear=existing soldier, Archer=NEW, Brute=NEW |
| Yu Jin 3 phases (60%/30%, volley, charges, leap, guard burst) | single-pattern boss | Rework boss AI on existing boss art (= Yu Jin) |
| Barrels / crates / food / fire / falling mast | auto +25 heal only | Props & hazards system |
| Arcade fixed + seeded Remix decks 2–5 | none | Authored variants + seeded RNG, seed shown |
| Score events, rank, medals, records, continues | flat kill score | Score/medals/localStorage (session fallback), continue restores encounter |
| Fleet scenery | land battlefield + camp | New fleet + flagship panoramas (`public/assets/bg/`) |
| Move list on ready screen & pause; last-hit enemy name/HP | title lists basics | Ready screen + pause move list; HUD target plate |
| Boss/stage music distinction, hazard/audio cues | one loop + SFX | Extend procedural audio (boss mode, cues) |

Media plan: keep all approved existing clips/sprites. New masters via
gpt-image-2 for sword/archer/brute + 2 backgrounds; new motion via
grok-imagine-video-1.5 image-to-video (helper `video-from-file.mjs`),
chroma-key pipeline identical to existing (see per-char `normalize.py` /
`provenance.json`). Up to 3 attempts per difficult action. The game ships
only finished local sprite frames; no runtime AI calls.
