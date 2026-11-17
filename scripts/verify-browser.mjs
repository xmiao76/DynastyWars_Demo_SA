// Browser verification for the Dynasty Wars demo.
//
// Prereqs (local dev tooling, not shipped): Playwright resolved from the
// game-tools folder — override with PLAYWRIGHT_PACKAGE_JSON env var —
// and a static server for dist/ (started here via `npm run preview`).
//
// Usage: npm run build && node scripts/verify-browser.mjs [outDir]
// Drives the real game: title -> start -> move / attack / jump / pause,
// damage-once-per-swing, depth-lane miss, wave clear, boss victory,
// game over, restart, mute. Saves screenshots + a JSON report.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'verification'));
fs.mkdirSync(outDir, { recursive: true });

const pwPkg =
  process.env.PLAYWRIGHT_PACKAGE_JSON ??
  'C:/Users/qiyu0/AppData/Local/DeepSeekSuperagent/game-tools/package.json';
const require = createRequire(pwPkg);
const { chromium } = require('playwright');

const PORT = 4173;
const server = spawn('npm', ['run', 'preview'], {
  cwd: root,
  shell: true,
  stdio: 'ignore',
});

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail ? `— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('preview server did not start');
}

async function main() {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => failedRequests.push(req.url()));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 20000 });
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, '01-title.png') });
  check('title screen renders', true);

  const state = () => page.evaluate(() => window.__DYNASTY__?.state());
  const hook = (fn, ...args) =>
    page.evaluate(([f, a]) => window.__DYNASTY__?.[f](...a), [fn, args]);

  // Focus canvas & start via keyboard (also a user gesture for audio).
  await page.click('canvas');
  await page.keyboard.press('Enter');
  await sleep(900);
  let s = await state();
  check('game starts, player at full hp', s && s.phase === 'playing' && s.playerHp === 100, JSON.stringify(s));
  check('audio started after gesture', s?.audioStarted === true);
  check('no missing assets reported by game', await page.evaluate(() => (window.__DYNASTY_MISSING__ ?? []).length === 0),
    await page.evaluate(() => JSON.stringify(window.__DYNASTY_MISSING__ ?? [])));
  await page.screenshot({ path: path.join(outDir, '02-start.png') });

  // Movement right triggers wave 1.
  await page.keyboard.down('d');
  await sleep(1700);
  await page.keyboard.up('d');
  s = await state();
  check('player moved right and wave 1 spawned', s.playerX > 350 && s.enemiesAlive >= 2, `x=${s.playerX} enemies=${s.enemiesAlive} zone=${s.zone}`);

  // Helper: wait until the player can act (not hurt/down/attacking).
  const waitIdle = async () => {
    for (let i = 0; i < 40; i += 1) {
      const st = await state();
      if (st.playerState === 'idle' || st.playerState === 'walk') return st;
      await sleep(150);
    }
    return state();
  };

  // Depth-lane miss: pin enemies to a shallow lane, put the player in a
  // deep lane right beside one, attack — swing must whiff (depth check).
  await hook('setPlayerHp', 100);
  await waitIdle();
  s = await state();
  let target = s.enemies.find((e) => e.hp > 0);
  await hook('setEnemiesGy', 405);
  await hook('teleport', target.x - 50, 492);
  await page.keyboard.press('j');
  await sleep(650);
  s = await state();
  check('attack misses enemies outside depth lane', s.lastAttackHitCount === 0, `hits=${s.lastAttackHitCount}`);

  // Combat: stand next to first enemy in its lane, single swing must damage
  // each enemy it touches exactly once (8 dmg, not per-frame). Retry once
  // in case an enemy swing interrupts the first attempt.
  let swingDelta = 0;
  let swingHits = 0;
  for (let attempt = 0; attempt < 3 && swingHits === 0; attempt += 1) {
    await hook('setPlayerHp', 100);
    await waitIdle();
    s = await state();
    target = s.enemies.find((e) => e.hp > 0);
    await hook('teleport', target.x - 55, target.gy);
    await sleep(110);
    const hpBefore = (await state()).enemies.reduce((a, e) => a + e.hp, 0);
    await page.keyboard.press('j');
    await sleep(240); // strike frames: attack pose + slash fx
    if (attempt === 0) await page.screenshot({ path: path.join(outDir, '03-attack.png') });
    await sleep(430);
    s = await state();
    swingHits = s.lastAttackHitCount;
    swingDelta = hpBefore - s.enemies.reduce((a, e) => a + e.hp, 0);
  }
  check('single swing damages each enemy once (8 dmg/hit, not per-frame)',
    swingHits >= 1 && swingDelta === 8 * swingHits,
    `delta=${swingDelta} hits=${swingHits}`);

  // Jump + air attack (from a safe spot so nothing interrupts).
  await hook('setPlayerHp', 100);
  await waitIdle();
  await hook('teleport', 160, 450);
  await sleep(120);
  await page.keyboard.press('k');
  await sleep(180);
  s = await state();
  check('jump raises player (z>0)', s.playerZ > 10, `z=${s.playerZ}`);
  await page.keyboard.press('j');
  await sleep(150);
  await page.screenshot({ path: path.join(outDir, '04-jump-attack.png') });
  await sleep(900);
  s = await state();
  check('player lands after jump', s.playerZ === 0, `z=${s.playerZ}`);

  // Walk anim screenshot.
  await hook('teleport', 200, 450);
  await page.keyboard.down('d');
  await sleep(260);
  await page.screenshot({ path: path.join(outDir, '05-walk.png') });
  await page.keyboard.up('d');

  // Pause / resume.
  await page.keyboard.press('Escape');
  await sleep(250);
  s = await state();
  check('Esc pauses', s.phase === 'paused');
  await page.screenshot({ path: path.join(outDir, '06-pause.png') });
  await page.keyboard.press('Escape');
  await sleep(250);
  s = await state();
  check('Esc resumes', s.phase === 'playing');

  // Mute toggle.
  await page.keyboard.press('m');
  await sleep(150);
  s = await state();
  check('M mutes', s.muted === true);
  await page.keyboard.press('m');
  await sleep(150);
  s = await state();
  check('M unmutes', s.muted === false);

  // Clear wave 1 via hook, boundary should release.
  await hook('killAllEnemies');
  await sleep(700);
  s = await state();
  check('wave 1 clears and boundary releases', s.zone === -1 && s.zonesCleared >= 1, `zone=${s.zone} cleared=${s.zonesCleared}`);

  // Progress through waves 2 and 3 in order (the game blocks skipping):
  // walk/teleport to each trigger, confirm spawn, clear via hook.
  for (const [wave, tx] of [[2, 1250], [3, 2120]]) {
    await hook('teleport', tx, 450);
    await sleep(700);
    s = await state();
    check(`wave ${wave} spawns at its trigger`, s.zone === wave - 1 && s.enemiesAlive >= 3, `zone=${s.zone} enemies=${s.enemiesAlive}`);
    if (wave === 2) await page.screenshot({ path: path.join(outDir, '06b-wave2.png') });
    await hook('killAllEnemies');
    await sleep(700);
    s = await state();
    check(`wave ${wave} clears`, s.zone === -1 && s.zonesCleared >= wave, `cleared=${s.zonesCleared}`);
    await hook('setPlayerHp', 100); // keep the deterministic run alive
  }

  // Boss: enter the arena, fight briefly with real attacks,
  // then finish via hook to verify victory flow deterministically.
  await hook('teleport', 2850, 450);
  await sleep(800);
  s = await state();
  check('boss spawns in arena', s.bossHp !== null && s.bossHp >= 300, `bossHp=${s.bossHp}`);
  // Real combat vs the boss: land genuine combo swings (no damage hooks)
  // and confirm his hp actually falls.
  const bossHpStart = s.bossHp;
  for (let i = 0; i < 6; i += 1) {
    s = await state();
    if (!s || s.bossHp === null || s.bossHp <= bossHpStart - 24) break;
    await hook('setPlayerHp', 100);
    const bossNow = s.enemies.find((e) => e.kind === 'boss');
    if (bossNow) await hook('teleport', bossNow.x - 70, bossNow.gy);
    await sleep(110);
    await page.keyboard.press('j');
    await sleep(330);
    await page.keyboard.press('j'); // combo chain
    await sleep(520);
  }
  s = await state();
  check('real combo attacks damage the boss', s.bossHp !== null && s.bossHp <= bossHpStart - 16, `bossHp ${bossHpStart} -> ${s.bossHp}`);
  await page.screenshot({ path: path.join(outDir, '07-boss.png') });
  await hook('hurtBoss', 9999);
  await sleep(2200);
  s = await state();
  check('boss defeat reaches victory', s.phase === 'won', `phase=${s.phase}`);
  await page.screenshot({ path: path.join(outDir, '08-victory.png') });

  // Restart without reload.
  await page.keyboard.press('r');
  await sleep(1000);
  s = await state();
  check('restart resets hp/position/score', s.phase === 'playing' && s.playerHp === 100 && s.playerX < 300 && s.score === 0 && s.zonesCleared === 0, JSON.stringify(s));

  // Game over path.
  await hook('setPlayerHp', 5);
  await hook('hurtPlayer', 999);
  await sleep(2000);
  s = await state();
  check('player defeat reaches game over', s.phase === 'lost', `phase=${s.phase}`);
  await page.screenshot({ path: path.join(outDir, '09-gameover.png') });
  await page.keyboard.press('r');
  await sleep(900);
  s = await state();
  check('restart after game over works', s.phase === 'playing' && s.playerHp === 100, `phase=${s.phase} hp=${s.playerHp}`);

  const realErrors = consoleErrors.filter((e) => !/favicon/.test(e));
  check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
  const realFailed = failedRequests.filter((u) => !/favicon/.test(u));
  check('no failed asset requests', realFailed.length === 0, realFailed.slice(0, 5).join(' | '));

  await browser.close();
  const failed = checks.filter((c) => !c.ok);
  const report = { at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks, consoleErrors: realErrors, failedRequests: realFailed };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed}/${checks.length} checks passed. Report: ${path.join(outDir, 'report.json')}`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
  });
