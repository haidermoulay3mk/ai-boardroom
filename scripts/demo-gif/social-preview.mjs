// Render docs/social-preview.png (1280x640, GitHub's recommended size) from the app's own table + fonts.
import { chromium } from 'playwright-core';

const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1, colorScheme: 'light' });
await page.goto('http://localhost:3737/', { waitUntil: 'networkidle' });
await page.waitForSelector('.home-title');
await page.evaluate(async () => {
  const { TableView } = await import('/js/table.js');
  const cast = await fetch('/api/advisors').then(r => r.json());
  document.querySelector('.toasts')?.remove();
  document.body.innerHTML = `
    <style>
      body { margin: 0; overflow: hidden; }
      .og { position: relative; z-index: 1; width: 1280px; height: 640px; display: grid; grid-template-columns: 1fr 470px; align-items: center; gap: 24px; padding: 0 64px 0 84px; box-sizing: border-box; }
      .og-kicker { font: 650 15px/1 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--brass); }
      .og-title { margin: 18px 0 18px; font: 400 128px/.92 var(--serif); letter-spacing: -.035em; color: var(--ink); }
      .og-title em { color: var(--brass); font-style: italic; }
      .og-sub { margin: 0; max-width: 560px; font: 400 31px/1.32 var(--serif); color: var(--ink-2); }
      .og-meta { margin-top: 34px; display: flex; gap: 12px; flex-wrap: wrap; }
      .og-chip { padding: 9px 16px; border-radius: 999px; border: 1px solid var(--rule-2); background: var(--card); font: 600 16px/1 var(--sans); color: var(--ink-2); }
      .og-table { padding: 22px; border-radius: 28px; background: var(--card); border: 1px solid var(--rule); box-shadow: var(--shadow); }
      .og-table .table { max-width: 420px; }
      .og-table .seat-avatar { box-shadow: 0 0 0 3px var(--card), 0 8px 16px -8px rgba(30,18,6,.65); }
    </style>
    <div class="og">
      <div>
        <div class="og-kicker">Open source · Runs on Claude Code</div>
        <h1 class="og-title">Board<em>room</em></h1>
        <p class="og-sub">Eight AI advisors argue your hard business decision. You leave with a scored verdict.</p>
        <div class="og-meta"><span class="og-chip">Live debate</span><span class="og-chip">Scored verdict</span><span class="og-chip">PDF report</span><span class="og-chip">No API key</span></div>
      </div>
      <div class="og-table" id="t"></div>
    </div>`;
  const t = new TableView(document.getElementById('t'));
  t.setCast(cast.chair, cast.advisors);
  const lean = { buffett: 'C', cardone: 'A', graham: 'C', hormozi: 'C', bezos: 'A', vaynerchuk: 'A', wickman: 'C', martell: 'C' };
  const state = { cardone: { speaking: true } };
  for (const [id, l] of Object.entries(lean)) state[id] = { ...(state[id] ?? {}), lean: l };
  t.setState(state);
  t.setCenter('74', 'out of 100');
  await document.fonts.ready;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
