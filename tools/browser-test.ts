// Drives the real client in headless Edge with keyboard input and checks gameplay state.
// Usage: npm run dev (in another terminal), then: npx tsx tools/browser-test.ts
import puppeteer from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.SAO_URL ?? 'http://localhost:5173/?peace';

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

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
process.exit(results.every(r => r[1]) && !errors.length ? 0 : 1);
