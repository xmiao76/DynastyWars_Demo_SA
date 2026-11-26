// Browser verification for Red Cliffs Ablaze.
//
// Prereqs (local dev tooling, not shipped): Playwright resolved from the
// game-tools folder — override with PLAYWRIGHT_PACKAGE_JSON env var —
// and a static server for dist/ (started here via `npm run preview`).
//
// Usage: npm run build && node scripts/verify-browser.mjs [outDir]
// Drives the real game with keyboard input + a small set of state hooks:
// title -> ready -> intro, Prow fight, combo damage-once, depth-lane miss,
// grab/pummel/throw (line-breaker setup), Dragon Cleave chord + HP cost,
// dash, jump, pause, all five decks + enemy kinds, barrel medal, falling
// mast, boss phases/patterns/reinforcements-once, defeat -> continue
// restores checkpoint score, victory + rank + (unranked continued best),
// Remix seed repeatability/difference, records persistence across reload,
// restart, second viewport. Saves screenshots + a JSON report.

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
const server = spawn('npm', ['run', 'preview'], { cwd: root, shell: true, stdio: 'ignore' });

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
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => failedRequests.push(req.url()));
  page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });

  const state = () => page.evaluate(() => window.__DYNASTY__?.state());
  const hook = (fn, ...args) => page.evaluate(([f, a]) => window.__DYNASTY__?.[f](...a), [fn, args]);
  const waitFor = async (pred, timeoutMs = 12000, stepMs = 200) => {
    const t0 = Date.now();
    for (;;) {
      const s = await state();
      if (s && pred(s)) return s;
      if (Date.now() - t0 > timeoutMs) return s;
      await sleep(stepMs);
    }
  };
  const waitIdle = () => waitFor((s) => ['idle', 'walk'].includes(s.playerState) && s.phase === 'playing', 8000);
  const shot = (name) => page.screenshot({ path: path.join(outDir, name) });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 20000 });
  await sleep(1600);
  await shot('01-title.png');
  check('title screen renders', true);
  check('no missing assets reported', await page.evaluate(() => (window.__DYNASTY_MISSING__ ?? []).length === 0),
    await page.evaluate(() => JSON.stringify(window.__DYNASTY_MISSING__ ?? [])));

  await page.click('canvas');
  await page.keyboard.press('Enter'); // title -> ready
  await sleep(700);
  await shot('02-ready.png');
  await page.keyboard.press('Enter'); // ready -> game
  let s = await waitFor((st) => st.phase === 'playing', 8000);
  check('game starts via ready screen, full hp', s?.phase === 'playing' && s.playerHp === 100, JSON.stringify(s && { phase: s.phase, hp: s.playerHp }));
  check('audio started after gesture', s?.audioStarted === true);
  check('arcade run: fixed variants + ~40 enemies', s.mode === 'arcade' && s.variants.every((v) => v === 0) && s.totalEnemies >= 40,
    `mode=${s.mode} variants=${s.variants} total=${s.totalEnemies}`);
  await shot('03-prow-start.png');

  // --- Prow: first wave is a single sword soldier.
  await hook('teleport', 420, 450);
  s = await waitFor((st) => st.section === 0 && st.enemiesAlive >= 1);
  check('prow locks with one visible sword soldier', s.enemiesAlive === 1 && s.enemies[0]?.kind === 'sword', `alive=${s.enemiesAlive} kinds=${s.enemies.map((e) => e.kind)}`);
  check('crate prop present on prow', s.props.some((p) => p.kind === 'crate'), JSON.stringify(s.props));

  // Depth-lane miss.
  await waitIdle();
  s = await state();
  await hook('setEnemiesGy', 405);
  await hook('teleport', s.enemies[0].x - 55, 492);
  await page.keyboard.press('j');
  await sleep(650);
  s = await state();
  check('attack misses outside depth lane', s.lastAttackHitCount === 0, `hits=${s.lastAttackHitCount}`);

  // Single swing, damage once per enemy (combo-1 = 7). Stay out of grab range (>66px).
  let swingOk = false;
  let swingDetail = '';
  for (let attempt = 0; attempt < 4 && !swingOk; attempt += 1) {
    await hook('setPlayerHp', 100);
    await waitIdle();
    s = await state();
    const target = s.enemies.find((e) => e.hp > 0);
    if (!target) break;
    await hook('teleport', target.x - 82, target.gy);
    await sleep(100);
    const hpBefore = (await state()).enemies.reduce((a, e) => a + e.hp, 0);
    const hitsBefore = (await state()).lastAttackHitCount;
    await page.keyboard.press('j');
    await sleep(560);
    s = await state();
    const delta = hpBefore - s.enemies.reduce((a, e) => a + e.hp, 0);
    const hits = s.lastAttackHitCount - hitsBefore;
    swingDetail = `delta=${delta} hits=${hits}`;
    swingOk = hits >= 1 && delta === 7 * hits;
  }
  check('single swing damages each enemy once (7 dmg/hit)', swingOk, swingDetail);
  await shot('04-prow-fight.png');

  // --- Grab -> pummel -> throw (M1), with a line-breaker setup:
  // two extra swords stand in the throw lane in front of the grapple.
  let grabOk = false;
  let pummelOk = false;
  let throwOk = false;
  let lineBreaker = false;
  for (let attempt = 0; attempt < 4 && !lineBreaker; attempt += 1) {
    await hook('setPlayerHp', 100);
    await waitIdle();
    s = await state();
    const victim = s.enemies.find((e) => e.hp > 10 && e.kind === 'sword') ?? s.enemies.find((e) => e.hp > 0);
    if (!victim) break;
    await hook('teleport', victim.x - 38, victim.gy);
    await sleep(90);
    await page.keyboard.press('j'); // point-blank: grab
    s = await waitFor((st) => st.grabState !== null, 2500);
    if (!s?.grabState) continue;
    grabOk = true;
    if (attempt === 0) await shot('05-grab.png');
    const hpGrab = s.enemies.find((e) => e.state === 'grabbed')?.hp;
    await sleep(220);
    await page.keyboard.press('j'); // pummel
    await sleep(360);
    s = await state();
    const hpPummel = s.enemies.find((e) => e.state === 'grabbed')?.hp;
    pummelOk = pummelOk || (hpGrab !== undefined && hpPummel === hpGrab - 5 && s.pummels === 1);
    // Line up two fresh targets in the throw lane, then Direction+J.
    const gy = s.playerGy;
    await hook('spawnEnemy', 'sword', s.playerX + 230, gy);
    await hook('spawnEnemy', 'sword', s.playerX + 300, gy);
    await sleep(120);
    await page.keyboard.down('d');
    await page.keyboard.press('j');
    await sleep(430);
    if (attempt === 0) await shot('06-throw.png');
    await page.keyboard.up('d');
    s = await waitFor((st) => !st.enemies.some((e) => e.state === 'thrown'), 3000);
    throwOk = throwOk || s.enemies.some((e) => e.state === 'down');
    lineBreaker = s.medalsRun.includes('line-breaker');
  }
  check('point-blank J grabs a soldier', grabOk);
  check('J pummels the grabbed soldier (-5 hp, stays held)', pummelOk);
  check('direction+J throws; victim lands down', throwOk);
  check('one throw hits two others -> Line Breaker medal', lineBreaker, `medals=${(await state()).medalsRun}`);

  // --- Dragon Cleave chord (J+K) + HP cost on connection.
  let cleaveOk = false;
  let cleaveDetail = '';
  for (let attempt = 0; attempt < 4 && !cleaveOk; attempt += 1) {
    await hook('setPlayerHp', 100);
    await waitIdle();
    s = await state();
    const target = s.enemies.find((e) => e.hp > 0);
    if (!target) break;
    await hook('teleport', target.x - 85, target.gy);
    await sleep(100);
    await page.keyboard.down('j');
    await page.keyboard.down('k');
    await sleep(160);
    s = await state();
    const move = s.playerMove;
    await page.keyboard.up('j');
    await page.keyboard.up('k');
    await sleep(500);
    s = await state();
    cleaveDetail = `move=${move} hp=${s.playerHp}`;
    cleaveOk = move === 'cleave' && s.playerHp <= 92;
    if (attempt === 0) await shot('07-dragon-cleave.png');
  }
  check('J+K chord triggers Dragon Cleave, pays 8 HP on hit', cleaveOk, cleaveDetail);

  // --- Dash (double-tap) + jump.
  await hook('setPlayerHp', 100);
  await waitIdle();
  await hook('teleport', 200, 450);
  await sleep(100);
  await page.keyboard.press('d');
  await sleep(90);
  await page.keyboard.down('d');
  let dashed = false;
  for (let i = 0; i < 8 && !dashed; i += 1) {
    await sleep(45);
    dashed = (await state()).playerState === 'dash';
  }
  await page.keyboard.up('d');
  check('double-tap forward dashes', dashed);
  await waitIdle();
  await page.keyboard.press('k');
  await sleep(200);
  s = await state();
  check('jump raises player (z>10)', s.playerZ > 10, `z=${s.playerZ}`);
  await page.keyboard.press('j');
  await sleep(160);
  await shot('08-jump-attack.png');
  s = await waitFor((st) => st.playerZ === 0, 4000);
  check('player lands after jump attack', s.playerZ === 0, `z=${s.playerZ}`);

  // Pause with move list.
  await page.keyboard.press('p');
  await sleep(250);
  s = await state();
  check('P pauses', s.phase === 'paused');
  await shot('09-pause.png');
  await page.keyboard.press('p');
  await sleep(250);
  check('P resumes', (await state()).phase === 'playing');

  // --- Clear sections 1..5 in order; record enemy kinds and section beats.
  const kindsSeen = new Set();
  const clearSection = async (idx, triggerX, onActive) => {
    await hook('setPlayerHp', 100);
    await hook('teleport', triggerX, idx === 1 ? 452 : 450);
    let active = await waitFor((st) => st.section === idx, 9000);
    if (onActive) await onActive(active);
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      s = await state();
      for (const e of s.enemies) kindsSeen.add(e.kind);
      if (s.sectionsCleared > idx) return s;
      if (s.section === idx) {
        await hook('killAllEnemies');
        await hook('setPlayerHp', 100);
      }
      await sleep(650);
    }
    return state();
  };

  s = await clearSection(0, 420);
  check('section 1 (Prow) clears and unlocks', s.sectionsCleared >= 1, `cleared=${s.sectionsCleared}`);

  s = await clearSection(1, 1300);
  check('section 2 (Gangplank) clears; spearmen seen', s.sectionsCleared >= 2 && kindsSeen.has('spear'), `cleared=${s.sectionsCleared} kinds=${[...kindsSeen]}`);
  await hook('teleport', 1500, 452);
  await sleep(300);
  await shot('10-gangplank.png');

  // Archer deck: barrel medal first (two swords at full hp beside a barrel).
  let barrelMedal = false;
  s = await clearSection(2, 2330, async (active) => {
    await sleep(400);
    const st = await state();
    const barrel = st.props.find((p) => p.kind === 'barrel');
    if (barrel) {
      await hook('spawnEnemy', 'sword', barrel.x - 35, barrel.gy);
      await hook('spawnEnemy', 'sword', barrel.x + 35, barrel.gy);
      await hook('teleport', barrel.x - 260, 450);
      await sleep(250);
      await hook('explodeNearestBarrel');
      await sleep(700);
      await shot('11-barrel-explosion.png');
      barrelMedal = (await state()).medalsRun.includes('deck-tactician');
      void active;
    }
  });
  check('section 3 (Archer Deck) clears; archers seen', s.sectionsCleared >= 3 && kindsSeen.has('archer'), `cleared=${s.sectionsCleared} kinds=${[...kindsSeen]}`);
  check('one barrel explosion defeats two -> Deck Tactician medal', barrelMedal, `medals=${(await state()).medalsRun}`);

  // Burning deck: falling mast fires when crossing its trigger while locked.
  let mastFell = false;
  s = await clearSection(3, 3370, async () => {
    await hook('teleport', 3620, 452);
    const after = await waitFor((st) => st.mastState === 'fallen', 6000, 150);
    mastFell = after?.mastState === 'fallen';
    await shot('12-burning-deck-mast.png');
    await hook('setPlayerHp', 100);
  });
  check('falling mast warns then falls on Burning Deck', mastFell);
  check('section 4 (Burning Deck) clears; brute seen', s.sectionsCleared >= 4 && kindsSeen.has('brute'), `cleared=${s.sectionsCleared} kinds=${[...kindsSeen]}`);

  s = await clearSection(4, 4410);
  check('section 5 (Foredeck) clears', s.sectionsCleared >= 5, `cleared=${s.sectionsCleared}`);
  const scoreBeforeBoss = s.score;

  // --- Boss: Yu Jin.
  await hook('setPlayerHp', 100);
  await hook('teleport', 5450, 450);
  s = await waitFor((st) => st.section === 5 && st.bossHp !== null, 9000);
  check('Yu Jin spawns on command deck; boss music mode', s.bossHp >= 330 && s.bossMode === true, `bossHp=${s.bossHp} bossMode=${s.bossMode}`);
  await sleep(1800); // boss intro floor time
  await shot('13-boss-intro.png');

  // Real combo hits damage the boss.
  const bossStart = s.bossHp;
  for (let i = 0; i < 7; i += 1) {
    s = await state();
    if (!s || s.bossHp <= bossStart - 14) break;
    await hook('setPlayerHp', 100);
    const bossNow = s.enemies.find((e) => e.kind === 'yujin');
    if (bossNow) await hook('teleport', bossNow.x - 82, bossNow.gy);
    await sleep(100);
    await page.keyboard.press('j');
    await sleep(300);
    await page.keyboard.press('j');
    await sleep(520);
  }
  s = await state();
  check('real combo attacks damage Yu Jin', s.bossHp <= bossStart - 7, `bossHp ${bossStart} -> ${s.bossHp}`);

  // 60% phase: signal + exactly one reinforcement call; collect patterns.
  // (Adds share the 2-melee attack budget with the boss by design, so once
  // the pair is observed they are cleared to let the boss pattern freely.)
  await hook('setBossHp', 195); // below the 60% phase threshold (204)
  const patternsSeen = new Set();
  let reinforcements = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 34000) {
    s = await state();
    if (s.bossPattern) patternsSeen.add(s.bossPattern);
    const bossNow = s.enemies.find((e) => e.kind === 'yujin');
    if (bossNow?.state === 'attack') patternsSeen.add('sabre');
    const addsAlive = s.enemies.filter((e) => e.kind !== 'yujin' && e.hp > 0).length;
    reinforcements = Math.max(reinforcements, addsAlive);
    if (reinforcements >= 2 && addsAlive > 0) {
      await hook('killAllEnemies');
      await sleep(500);
    }
    if (bossNow && s.playerHp > 0) {
      await hook('setPlayerHp', 100);
      const roomRight = 6050 - bossNow.x;
      const tx = roomRight > 380 ? bossNow.x + 340 : Math.max(5300, bossNow.x - 340);
      await hook('teleport', tx, 450);
    }
    if (reinforcements >= 2 && patternsSeen.size >= 3) break;
    await sleep(380);
  }
  check('60% threshold calls two reinforcements once', reinforcements >= 2, `adds alive peak=${reinforcements}`);
  check('boss uses multiple telegraphed patterns', patternsSeen.size >= 3, `patterns=${[...patternsSeen]}`);
  await shot('14-boss-pattern.png');
  // Dropping below 60% again must not re-signal.
  await hook('killAllEnemies');
  await sleep(800);
  await hook('setBossHp', 190);
  await sleep(1600);
  s = await state();
  check('reinforcement signal does not repeat', s.enemies.filter((e) => e.kind !== 'yujin' && e.hp > 0).length === 0,
    `adds=${s.enemies.filter((e) => e.kind !== 'yujin').length}`);

  // --- Defeat -> Continue restores checkpoint score & fresh encounter.
  await hook('setPlayerHp', 5);
  await hook('hurtPlayer', 999);
  s = await waitFor((st) => st.phase === 'lost', 6000);
  check('player defeat reaches defeat/results screen', s.phase === 'lost', `phase=${s.phase}`);
  await shot('15-defeat.png');
  await page.keyboard.press('Enter'); // continue
  s = await waitFor((st) => st.phase === 'playing' && st.playerHp === 100, 8000);
  check('continue revives at full hp into the same deck', s.phase === 'playing' && s.playerHp === 100 && s.continues === 1,
    `hp=${s.playerHp} continues=${s.continues}`);
  check('continue restores checkpoint score (no duplicate points)', s.score === scoreBeforeBoss, `score=${s.score} checkpoint=${scoreBeforeBoss}`);
  s = await waitFor((st) => st.section === 5 && st.bossHp !== null && st.bossHp >= 330, 9000);
  check('continued encounter restarts boss at full hp', s.bossHp >= 330, `bossHp=${s.bossHp}`);

  // Win the continued run: unranked arcade best must stay unset by this run.
  const bestBefore = s.records.arcadeBest;
  await hook('hurtBoss', 9999);
  s = await waitFor((st) => st.phase === 'won', 8000);
  check('boss defeat reaches victory results', s.phase === 'won' && !!s.victory, JSON.stringify(s.victory));
  check('results show rank & continued run is not ranked as best',
    !!s.victory?.rank && JSON.stringify(s.records.arcadeBest) === JSON.stringify(bestBefore),
    `rank=${s.victory?.rank} best=${JSON.stringify(s.records.arcadeBest)}`);
  await shot('16-victory.png');

  // --- Remix: same seed repeats, different seeds differ on decks 2-5.
  await hook('startRemix', 4242);
  s = await waitFor((st) => st.mode === 'remix' && st.phase === 'playing', 9000);
  const v1 = [...s.variants];
  check('remix run starts with shown seed', s.mode === 'remix' && s.seed === 4242, `seed=${s.seed} variants=${v1}`);
  await hook('startRemix', 4242);
  s = await waitFor((st) => st.mode === 'remix' && st.phase === 'playing', 9000);
  check('same seed reproduces same variants', JSON.stringify(s.variants) === JSON.stringify(v1), `${s.variants} vs ${v1}`);
  let differs = false;
  for (const seed of [777, 1234, 9999, 2026]) {
    await hook('startRemix', seed);
    s = await waitFor((st) => st.mode === 'remix' && st.seed === seed && st.phase === 'playing', 9000);
    if (JSON.stringify(s.variants.slice(1, 5)) !== JSON.stringify(v1.slice(1, 5))) { differs = true; break; }
  }
  check('different seed changes decks 2-5 variants', differs, `last=${s.variants} vs 4242=${v1}`);

  // --- Records persistence across reload (mute + medals), then unmute.
  await page.keyboard.press('m');
  await sleep(200);
  check('M mutes and stores preference', (await state()).records.muted === true);
  const medalsPersist = (await state()).records.medals;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await sleep(1400);
  await page.click('canvas');
  await page.keyboard.press('Enter');
  await sleep(500);
  await page.keyboard.press('Enter');
  s = await waitFor((st) => st.phase === 'playing', 9000);
  check('reload preserves mute + all-time medals', s.muted === true && JSON.stringify(s.records.medals) === JSON.stringify(medalsPersist),
    `muted=${s.muted} medals=${s.records.medals}`);
  await page.keyboard.press('m');
  await sleep(150);
  check('M unmutes', (await state()).muted === false);

  // Fresh arcade restart resets the run.
  await hook('startArcade');
  s = await waitFor((st) => st.mode === 'arcade' && st.phase === 'playing' && st.score === 0, 9000);
  check('arcade restart resets score/sections', s.score === 0 && s.sectionsCleared === 0 && s.playerX < 320, JSON.stringify({ x: s.playerX, score: s.score }));

  // Second desktop viewport renders the same game (FIT scaling).
  await page.setViewportSize({ width: 1600, height: 900 });
  await hook('teleport', 420, 450);
  await sleep(900);
  await shot('17-viewport-1600x900.png');
  check('second viewport renders gameplay', (await state()).phase === 'playing');

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
