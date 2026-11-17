# Implementation plan & media-capability summary

Baseline: commit `ec92051` ("Initial commit") — repository contained only
`.gitattributes`. **No runnable game existed**, so there is no meaningful
"Before" gameplay capture; verification evidence is After-only by necessity,
with this baseline documented here and in the PR.

## Stack
TypeScript + Vite + Phaser 3, static build (`dist/`) suitable for
Cloudflare Pages. No backend, no runtime AI calls, no accounts.

## Media capabilities (verified in this environment, 2026-11-17 preflight)
- Coding/orchestration model: Muse-Wonder-Full-1.0-contributor (xhigh).
  Media tools call separate models; using them does not change the coding model.
- Image generation + reference-image editing: native `image_generate`,
  ChatGPT subscription, **gpt-image-2** (live generation and reference edit
  both verified in preflight).
- Image-to-video: native `video_generate` / local-file helper
  (`video-from-file.mjs`), Grok subscription, **grok-imagine-video-1.5**.
  Args: prompt, duration 1–15s, aspect_ratio, resolution, image_url.
  **No ending-frame or exact-loop control** exists; frame 1 is not guaranteed
  to match the conditioning image exactly.
- Processing: FFmpeg frame extraction, magenta chroma-key background removal
  (preserves thin weapons better than the installed rembg/u2netp model, which
  damaged a weapon in testing), fixed-canvas packing, contact sheets —
  via `asset-pipeline.py` in the local game-tools venv.
- Browser verification: Playwright + headless Chromium (keyboard input,
  screenshots, console/network capture).

## Animation workflow (milestone 1 POC, then reused)
1. One immutable master reference per character on flat magenta (#ff00ff),
   full body + full weapon with generous margin, side view facing right.
   Guan Yu's master is derived by reference-edit from the preflight master
   (same face/costume/weapon) into a ready stance with more weapon clearance.
2. One short video clip per action (idle / walk / attack), locked camera,
   in-place motion, flat magenta background.
3. Extract frames → chroma-key → select/retime frames → normalize every
   action of a character onto one shared canvas + ground line (never
   per-pose crop/resize) → transparent PNG frames + per-character manifest.
4. Inspect contact sheets for identity drift, weapon bending/cropping,
   scale/camera drift, keying spill, loop seams. Max 3 generation attempts
   per action; then change approach and report honestly.
5. Game code owns movement, hitboxes, damage timing and i-frames; sprites
   never dictate combat rules.

## Game structure
- `BootScene`: manifest/asset preload with progress + error surface,
  animation registration.
- `TitleScene`: title, controls, start.
- `GameScene`: one stage (~3400px), depth-band ground plane, camera-lock
  encounters (3 waves), boss arena, HUD, pause, victory/game-over overlays,
  in-place restart.
- Combat: 3-hit ground combo, jump + air attack, hit-stop, restrained
  shake, knockback/knockdown, brief post-hit invulnerability, attacker
  tokens (max 2 simultaneous enemy attackers), telegraphed boss attacks
  with punishable recovery.
- Audio: procedurally synthesized Web Audio SFX + music loop (no external
  audio files to license), starts on first user gesture, `M` mute.

## Verification
`npm run build`, then Playwright script (`scripts/verify-browser.mjs`)
drives the preview build: title → start → move/attack/jump/pause,
damage checks, screenshots at each stage; screenshots are visually
inspected. Results and limitations are reported in the PR — build success
alone is not claimed as animation quality.
