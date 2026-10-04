// Screenshot the running client (npm run dev) in headless Edge.
// Usage: npx tsx tools/screenshot.ts "<query>" <out.png> [waitMs]
//   e.g. npx tsx tools/screenshot.ts "?autoplay&notrain&t=20" shot.png 4000
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [query = '', out = 'shot.png', waitMs = '3000'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  // A throwaway profile, so this works while your own Edge is open.
  userDataDir: mkdtempSync(join(tmpdir(), 'sao-shot-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', e => console.log('page error:', String(e)));
await page.goto(`http://localhost:5173/${query}`);
await page.waitForFunction('window.__sao && window.__sao.fight', { timeout: 60000 });
await new Promise(r => setTimeout(r, Number(waitMs)));
await page.screenshot({ path: out as `${string}.png` });
console.log(`saved ${out}`);
await browser.close();
