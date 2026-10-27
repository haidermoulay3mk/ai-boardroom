// Render the README GIF frames with headless Microsoft Edge, driven by the stop-motion director.
// usage: npm install && npm run record -- <session-id> && npm run encode
// Needs Boardroom running on :3737 and Microsoft Edge installed (playwright-core drives it; no browser download).
// The session id is a file name in data/sessions/ (without .json); the director expects a Quick/Standard
// meeting with a debate round and a verdict.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
if (!process.argv[2]) throw new Error('usage: node capture.mjs <session-id>');

const here = dirname(fileURLToPath(import.meta.url));
const framesDir = join(here, 'frames');
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const director = readFileSync(join(here, 'director.js'), 'utf8');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
page.on('crash', () => console.error('PAGE CRASHED'));
page.on('pageerror', err => console.error('page error:', err.message));

await page.goto('http://localhost:3737/', { waitUntil: 'networkidle' });
await page.waitForSelector('.home-title');
await page.waitForTimeout(1500);
await page.evaluate(id => { window.__DEMO_SESSION__ = id; }, process.argv[2]);
const delays = JSON.parse(await page.evaluate(director));
console.log(`director ready: ${delays.length} frames`);

const t0 = Date.now();
for (let i = 0; i < delays.length; i++) {
  await page.evaluate(n => window.__go(n), i);
  await page.screenshot({ path: join(framesDir, `f${String(i).padStart(3, '0')}.png`) });
  if (i % 10 === 0) console.log(`frame ${i} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
writeFileSync(join(here, 'delays.json'), JSON.stringify(delays));
console.log(`captured ${delays.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
