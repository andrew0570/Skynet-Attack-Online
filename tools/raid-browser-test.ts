// Two real clients raid together: both join from the start screen, one starts the raid, and we
// check the team, live movement sync, hit reporting, and the server-run Skynet.
// Usage: npm run dev + local DB, then: npx tsx tools/raid-browser-test.ts [screenshotDir]
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.argv[2];
const launch = () =>
  puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'sao-raid-')),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=960,540'],
  });
const [ba, bb] = await Promise.all([launch(), launch()]);
const open = async (b: typeof ba, name: string, color: string): Promise<Page> => {
  const p = await b.newPage();
  await p.setViewport({ width: 960, height: 540 });
  p.on('pageerror', e => console.log(`[${name}] page error:`, String(e)));
  await p.goto('http://localhost:5173/?autoplay&pitch=-0.45');
  await p.waitForFunction('window.__sao && window.__sao.net.status.connected', { timeout: 60000 });
  await p.evaluate(
    (n, c) => {
      (document.getElementById('start-name') as HTMLInputElement).value = n;
      const sw = [...document.querySelectorAll<HTMLInputElement>('input[name="color"]')].find(i => i.value === c)!;
      sw.checked = true;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      (document.getElementById('mode-raid') as HTMLInputElement).checked = true;
      const no = document.getElementById('consent-no') as HTMLInputElement;
      no.checked = true;
      no.dispatchEvent(new Event('change', { bubbles: true }));
      (document.getElementById('start-form') as HTMLFormElement).requestSubmit();
    },
    name,
    color
  );
  return p;
};
type Sao = { net: { raid: { members(): { name: string; isBot: boolean; state: string; dealt: number; owner: string }[]; current(): { status: string; bossHp: number; bossMaxHp: number; tick: number } | undefined; me(): { owner: string } | undefined; start(): void } } };
const raidInfo = (p: Page) =>
  p.evaluate(() => {
    const r = (window as unknown as { __sao: Sao }).__sao.net.raid;
    const cur = r.current();
    return { status: cur?.status ?? 'none', hp: cur?.bossHp ?? 0, max: cur?.bossMaxHp ?? 0, tick: cur?.tick ?? 0, me: r.me()?.owner ?? '', members: r.members().map(m => ({ name: m.name, bot: m.isBot, state: m.state, dealt: m.dealt, owner: m.owner })) };
  });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: [string, boolean, string][] = [];

const a = await open(ba, 'Alpha', '#5dff6a');
const b = await open(bb, 'Bravo', '#ff4fd8');
await sleep(1500);
const la = await raidInfo(a);
const lb = await raidInfo(b);
results.push(['both players land in the same lobby', la.status === 'lobby' && lb.status === 'lobby' && la.members.filter(m => !m.bot).length === 2, `A sees ${la.members.map(m => m.name).join(', ')}`]);
const lobbyShown = await a.evaluate(() => !document.getElementById('lobby')!.classList.contains('hidden'));
results.push(['lobby screen is shown', lobbyShown, '']);
if (dir) await a.screenshot({ path: `${dir}/raid-lobby.png` });

await a.click('#lobby-start');
await sleep(1500);
const sa = await raidInfo(a);
const sb = await raidInfo(b);
results.push(['start: both clients see an active 5-member raid', sa.status === 'active' && sb.status === 'active' && sb.members.length === 5, `${sb.members.map(m => `${m.name}${m.bot ? '' : '*'}`).join(', ')}`]);

// Alpha runs forward and fires a sword beam + lightning at Skynet.
const posOf = (info: Awaited<ReturnType<typeof raidInfo>>, name: string) => {
  const m = info.members.find(x => x.name === name);
  return m?.state ? (JSON.parse(m.state).pos as { x: number; z: number }) : null;
};
const before = posOf(await raidInfo(b), 'Alpha');
await a.keyboard.down('KeyW');
await sleep(1500);
await a.keyboard.up('KeyW');
// Then step into the glade under Skynet (clients own their movement) and fire, like the solo skills test.
await a.evaluate(() => {
  const f = (window as unknown as { __sao: { fight: { player: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } } } }).__sao.fight;
  f.player.pos = { x: 0, y: 0.5, z: 26 };
  f.player.vel = { x: 0, y: 0, z: 0 };
});
await sleep(1500);
await a.keyboard.press('Digit1');
await sleep(600);
await a.keyboard.press('Digit3');
await sleep(2500);
const after = await raidInfo(b);
const local = await a.evaluate(() => {
  const s = (window as unknown as { __sao: { fight: { time: number; outcome: string; player: { pos: { x: number; z: number } } } } }).__sao;
  return { time: s.fight.time, outcome: s.fight.outcome, pos: s.fight.player.pos, active: document.activeElement?.tagName, lobbyHidden: document.getElementById('lobby')!.classList.contains('hidden') };
});
console.log('alpha local:', JSON.stringify(local), 'alpha row state:', (await raidInfo(a)).members.find(m => m.name === 'Alpha')?.state.slice(0, 80));
const moved = posOf(after, 'Alpha');
results.push(["Bravo sees Alpha's movement (streamed via SpacetimeDB)", !!before && !!moved && Math.hypot(moved.x - before.x, moved.z - before.z) > 3, before && moved ? `Alpha ${before.z.toFixed(1)} → ${moved.z.toFixed(1)} (z)` : 'no state']);
const aimedDealt = after.members.find(m => m.name === 'Alpha')?.dealt ?? 0;
console.log('alpha local hit events:', JSON.stringify(await a.evaluate(() => (window as unknown as { __sao: { raidDebug: string[] } }).__sao.raidDebug)));
// A hit report straight through the client's raid link (server validates and applies it).
await a.evaluate(() => (window as unknown as { __sao: { net: { raid: { hit(a: number, s: string): void } } } }).__sao.net.raid.hit(40, 'beam'));
await sleep(800);
const alphaDealt = (await raidInfo(b)).members.find(m => m.name === 'Alpha')?.dealt ?? 0;
results.push(["Alpha's hit reports are applied by the server", alphaDealt > aimedDealt, `aimed shots dealt ${aimedDealt.toFixed(0)}; after a 40-damage report: ${alphaDealt.toFixed(0)}`]);
results.push(['server-run Skynet is taking damage', after.hp < after.max, `${after.hp.toFixed(0)} / ${after.max} HP, tick ${after.tick}`]);
const remotes = await b.evaluate(() => document.querySelectorAll('.nameplate').length);
results.push(['Bravo renders 4 teammates with nameplates', remotes === 4, `${remotes} nameplates`]);
if (dir) {
  await a.screenshot({ path: `${dir}/raid-alpha.png` });
  await b.screenshot({ path: `${dir}/raid-bravo.png` });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
await Promise.all([ba.close(), bb.close()]);
process.exit(failed ? 1 : 0);
