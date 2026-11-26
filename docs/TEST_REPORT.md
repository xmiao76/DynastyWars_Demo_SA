# Red Cliffs Ablaze — test report

Date: 2026-11-25 · Branch: `agent/red-cliffs-ablaze-bcccf103ff9f` · Baseline: `main` @ 8dcc252

## What was run

1. **Baseline first (M0).** The pre-refactor build was built and driven in
   headless Chromium: 26/26 checks passed (`verification-baseline/`,
   screenshots kept as `docs/screenshots/before-*`). Hero appearance, scale
   (275px canvas display height), attack strike timing (~55%), controls and
   a representative wave-1 fight were recorded in
   `docs/RED_CLIFFS_BASELINE.md`.
2. **Production build.** `npm run build` (tsc + Vite) passes; output is a
   static `dist/` with relative asset paths.
3. **Browser verification** (`node scripts/verify-browser.mjs`, report in
   `verification/report.json`): **47/47 checks passed**, no console/page
   errors, no failed asset requests, no missing assets. Covered paths:
   title → ready/move list → intro; Prow lock with one visible opponent;
   depth-lane whiff; damage exactly once per swing; point-blank grab,
   pummel (-5 HP, stays held), direction throw, thrown body hitting two
   others (**Line Breaker** awarded); J+K chord → Dragon Cleave paying
   8 HP on connection; double-tap dash; jump + air attack landing;
   pause/resume with move list; all five decks clearing in order with the
   sword/spear/archer/brute roles observed; one barrel defeating two
   (**Deck Tactician**); falling mast warning then fall; Yu Jin spawn +
   boss music, real combo damage, 60% signal with exactly two
   reinforcements called **once**, multiple telegraphed patterns
   (sabre/signal/volley in the sampled run); defeat → continue restoring
   checkpoint score exactly (5,740 = 5,740) with the boss reset to full HP;
   victory with rank and time bonus, continued run correctly **not**
   recorded as the Arcade best; Remix seed 4242 reproducing identical
   variants twice and other seeds differing on decks 2–5; mute + all-time
   medals surviving a page reload; restart resetting the run; a second
   desktop viewport (1600×900) in addition to 1280×800.
4. **Real-input bot soaks** (dev-only script, keyboard input only, no
   damage/teleport hooks; continues used as a player may). Three 9-minute
   runs: run 1 stalled on the flagship foredeck trading face-to-face with
   brutes (prompting a tune: brute 95→80 HP, 14→12 damage, one fewer
   foredeck foe); runs 2–3 then cleared all five decks by ~218s with
   3–4 continues and reached Yu Jin every time, observing his **charge**
   and **signal** patterns. The bot — which mostly trades blows instead of
   baiting recoveries like a player — did **not** defeat Yu Jin inside
   the budget in either run (7 deaths on the command deck in run 3, after
   a boss tune to 340 HP / 9 damage sabre). So the automated evidence
   proves *reach the boss through normal play*; a hook-free automated
   *victory* remains unproven, and boss difficulty for a dodging human is
   estimated from pattern recoveries (≈9 combo openings), not measured.

## Visuals inspected (actual captures)

Title, ready/move-list, Prow fight, grab hold (victim pinned at the
extended-hand grip point from the new video clip), throw with the victim
airborne into a rank (LINE BREAKER callout), Dragon Cleave, jump attack,
pause, gangplank over water, archer-deck barrel explosion with medal
banner, burning deck after the mast fall, Yu Jin introduction on the
flagship deck, boss pattern with reinforcements, defeat and victory
results (score breakdown, rank + next-rank target, medals earned/missed),
second viewport. New-character and throw contact sheets were inspected for
identity, weapon/bow/club cropping, foot contact on the shared ground
line and magenta fringe (see each `provenance.json`).

## Known gaps and honest limitations

- **Media:** Guan Yu's grab/throw is a real generated clip (attempt 1 of
  2; attempt 2 rejected — weapon vanished mid-heave). In the chosen clip
  he lays the guandao on the ground while grappling; kept and documented
  rather than painted out. Dash, air-attack variants, Dragon Cleave and
  Yu Jin's charge/leap reuse validated source clips with code timing and
  FX instead of bespoke clips. The brute is ~308px tall on canvas (not
  ~345px): his raised-club frame caps the global scale, documented in his
  provenance. The club head tints greenish during the brute swing (source
  video color drift). Archer bowstring is faint in idle after despill.
- **Boss patterns:** automated sampling observed sabre, signal, volley
  (verify script) and charge + signal (bot soaks). Double-charge, leap
  and guard-burst share the same telegraph plumbing but no deterministic
  check forced each one; and as noted above, no hook-free automated run
  beat the boss.
- **Balance:** rank thresholds were calibrated against the theoretical
  score pool plus bot runs (S 8800 / A 7300 / B 5600 / C 3800), not human
  playtests. Enemy tuning is likewise bot-informed only.
- **Audio** is verified to start and toggle programmatically; audible
  quality was not assessed. Blur auto-pause is wired (`Phaser` BLUR →
  pause) but not covered by the headless checks.
- Verification uses state hooks for deterministic progression (teleports,
  kill hooks) between the real-input combat checks, the same approach as
  the baseline suite; the bot soak above is the hook-free counterpart.
  Percentages of a human 6-minute Arcade clear are therefore estimates.
