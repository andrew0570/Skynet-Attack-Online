// Drives the real client in headless Edge with keyboard input and checks gameplay state.
// Usage: npm run dev (in another terminal), then: npx tsx tools/browser-test.ts
import puppeteer from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.SAO_URL ?? 'http://localhost:5173/?peace&autoplay';

type V = { x: number; y: number; z: number };
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=640,360'],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
// SAO_SLOW_CLOCK=1: the game sees time run 10x slower, so frames look ~5 ms apart like a
// high-refresh display (many frames with no sim tick). Real time waits below stretch to match.
const SLOW = process.env.SAO_SLOW_CLOCK === '1';
if (SLOW) {
  await page.evaluateOnNewDocument(() => {
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() * 0.1;
  });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, SLOW ? ms * 10 : ms));
await page.goto(URL);
await page.waitForFunction('window.__sao && window.__sao.fight', { timeout: 60000 });

const state = () =>
  page.evaluate(() => {
    const f = (window as unknown as { __sao: { fight: { player: { pos: V; onGround: boolean }; outcome: string; time: number } } }).__sao.fight;
    return { pos: { ...f.player.pos }, onGround: f.player.onGround, outcome: f.outcome, time: f.time };
  });
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);
const holdW = async (ms: number) => {
  await page.keyboard.down('KeyW');
  await wait(ms);
  await page.keyboard.up('KeyW');
};

const results: [string, boolean, string][] = [];
const s0 = await state();
await holdW(2500);
const s1 = await state();
results.push(['moves before restart', dist(s0.pos, s1.pos) > 1, `moved ${dist(s0.pos, s1.pos).toFixed(2)} m, sim t=${s1.time.toFixed(2)}`]);

await page.keyboard.press('KeyR');
await wait(800);
const s2 = await state();
await holdW(2500);
const s3 = await state();
results.push(['moves after pressing R', dist(s2.pos, s3.pos) > 1, `moved ${dist(s2.pos, s3.pos).toFixed(2)} m, sim t=${s2.time.toFixed(2)}→${s3.time.toFixed(2)}, onGround=${s3.onGround}, outcome=${s3.outcome}`]);

// Skills: from the glade, looking up at Skynet, press 1 / 3 / 2 and check each fires.
if (process.env.SAO_SKILLS === '1') {
  await page.goto('http://localhost:5173/?peace&shot&autoplay&at=0,26&pitch=-0.45');
  await page.waitForFunction('window.__sao && window.__sao.fight', { timeout: 60000 });
  const skillState = () =>
    page.evaluate(() => {
      const f = (window as unknown as { __sao: { fight: { skillCd: number[]; boss: { hp: number } } } }).__sao.fight;
      return { cd: [...f.skillCd], hp: f.boss.hp };
    });
  const shotDir = process.env.SAO_SHOTS;
  const hp0 = (await skillState()).hp;
  for (const [key, idx, name] of [['Digit1', 0, 'lightning'], ['Digit3', 2, 'beam'], ['Digit2', 1, 'rush']] as const) {
    await page.keyboard.press(key);
    await wait(name === 'lightning' ? 700 : 250);
    if (shotDir) await page.screenshot({ path: `${shotDir}/skill-${name}.png` });
    const s = await skillState();
    results.push([`skill ${key.slice(-1)} (${name}) fires and goes on cooldown`, s.cd[idx] > 0, `cooldown ${s.cd[idx].toFixed(1)} s`]);
  }
  await wait(1500);
  const hp1 = (await skillState()).hp;
  results.push(['skills damaged Skynet (aimed from the glade)', hp1 < hp0, `Skynet HP ${hp0} → ${hp1}`]);
}

// Learning loop (needs the local DB): consent, fight with the shared brain, lose, and check the
// fight was submitted and trained the shared brain.
if (process.env.SAO_BRAIN === '1') {
  type Sao = { fight: { outcome: string; health: number; armor: number }; fightPolicyVersion: number; submitted: boolean; net: { status: { connected: boolean; version: number; consented: boolean | null }; setConsent(v: boolean): void } };
  const sao = <T>(fn: (s: Sao) => T) => page.evaluate(fn as never, undefined) as Promise<T>;
  await page.goto('http://localhost:5173/?autoplay');
  await page.waitForFunction('window.__sao && window.__sao.net.status.connected', { timeout: 30000 });
  await page.evaluate(() => (window as unknown as { __sao: Sao }).__sao.net.setConsent(true));
  await page.waitForFunction('window.__sao.net.status.consented === true', { timeout: 10000 });
  const v0 = await sao(() => (window as unknown as { __sao: Sao }).__sao.net.status.version);
  await page.keyboard.press('KeyR'); // fresh fight: freezes the shared brain at its first tick
  await page.waitForFunction('window.__sao.fightPolicyVersion >= 0', { timeout: 10000 });
  const used = await sao(() => (window as unknown as { __sao: Sao }).__sao.fightPolicyVersion);
  // Make it short: one hit ends it (still a real fight with real Skynet decisions).
  await page.evaluate(() => {
    const f = (window as unknown as { __sao: Sao }).__sao.fight;
    f.armor = 0;
    f.health = 1;
  });
  await page.waitForFunction("window.__sao.fight.outcome !== 'active'", { timeout: 180000 });
  await page.waitForFunction(`window.__sao.net.status.version > ${v0}`, { timeout: 15000 }).catch(() => {});
  const after = await sao(() => {
    const s = (window as unknown as { __sao: Sao }).__sao;
    return { submitted: s.submitted, version: s.net.status.version, outcome: s.fight.outcome };
  });
  results.push(['fight used the shared brain', used === v0, `fought with v${used}`]);
  results.push(['finished fight trained the shared brain', after.submitted && after.version === v0 + 1, `outcome ${after.outcome}, brain v${v0} → v${after.version}`]);
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
process.exit(results.every(r => r[1]) && !errors.length ? 0 : 1);
