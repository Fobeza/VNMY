import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!filename.startsWith(root + path.sep) && filename !== root) { res.writeHead(403); res.end(); return; }
    const file = filename === root ? path.join(root, 'index.html') : filename;
    const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.VNMY_CHROMIUM ? { executablePath: process.env.VNMY_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const output = process.env.VNMY_SCREENSHOTS || '/tmp/vnmy-screenshots'; await fs.mkdir(output, { recursive: true });
try {
  await page.goto(address); await page.locator('.universe-card').first().waitFor();
  assert.equal(await page.locator('#btn-new-universe').isVisible(), false);
  await page.screenshot({ path: `${output}/library.png` });
  await page.locator('.universe-card').filter({ hasText: 'Свет у воды' }).click();
  await page.locator('.story-card').filter({ hasText: 'Пока горит август' }).click();
  await page.waitForFunction(() => document.querySelector('.stage .text')?.textContent.length > 10);
  const background = await page.locator('.stage .bg.is-active').evaluate(async node => {
    const src = getComputedStyle(node).backgroundImage.slice(5, -2);
    const image = new Image(); image.src = src; await image.decode(); return image.naturalWidth;
  });
  assert(background > 0);
  await page.screenshot({ path: `${output}/reading.png` });
  await page.locator('.quick-save').click();
  await page.getByRole('dialog', { name: 'Сохранения' }).waitFor();
  await page.locator('.save-slot-main').first().click();
  await page.locator('.save-slot.is-filled').waitFor();
  await page.screenshot({ path: `${output}/saves.png` });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
  await page.locator('.topbar-back').click(); await page.locator('#uni-back').click();
  await page.locator('.continue-card').waitFor();
  await page.screenshot({ path: `${output}/continue.png` });
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const story = store.createStory({ id: 'browser-long', title: 'Проверка чтения', universe: 'silent-rails', scenes: [{ id: 'long', name: 'Длинная реплика', bg: '', steps: [
      { id: 'long', text: 'Длинная реплика должна сохранять выбранный читателем размер. '.repeat(50) },
      { id: 'end', text: 'Финал', end: true },
    ] }] });
    store.saveStory(story); store.saveSettings({ fontSize: 1.35, reduceMotion: true }); await store.flushStorage();
  });
  await page.reload();
  await page.locator('.universe-card').filter({ hasText: 'Тихие пути' }).click();
  await page.locator('.story-card').filter({ hasText: 'Проверка чтения' }).click();
  for (const [width, height] of [[390,844],[320,568],[844,390],[1440,900]]) {
    await page.setViewportSize({ width, height });
    const metrics = await page.locator('.stage .text').evaluate(node => ({ font: parseFloat(getComputedStyle(node).fontSize), height: node.clientHeight, scroll: node.scrollHeight, width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(metrics.font >= 20, JSON.stringify(metrics)); assert(metrics.height > 0); assert(metrics.scroll > metrics.height); assert(metrics.width <= metrics.viewport);
    await page.screenshot({ path: `${output}/long-${width}x${height}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.topbar-back').click(); await page.locator('#uni-back').click(); await page.locator('#mode-author').click();
  await page.locator('.universe-card').filter({ hasText: 'Тихие пути' }).click();
  await page.locator('.story-card').filter({ hasText: 'Проверка чтения' }).locator('.story-card-menu').click();
  await page.getByRole('button', { name: /^Редактировать/ }).click();
  await page.getByRole('button', { name: 'Карта и поиск по сценарию' }).click();
  await page.getByRole('searchbox', { name: 'Поиск по сценарию' }).fill('Финал');
  await page.locator('.story-search-results .sheet-row').first().waitFor();
  await page.screenshot({ path: `${output}/editor-search.png` });
  await page.locator('.story-search-results .sheet-row').first().click();
  await page.locator('#ed-preview .ending-title').waitFor();
  // Standalone file is also exercised by the integration suite; verify real Chromium.
  const standalone = await context.newPage();
  await standalone.goto(`file://${root}/vnmy.html`);
  await standalone.locator('.universe-card').first().waitFor();
  await standalone.locator('.universe-card').filter({ hasText: 'Свет у воды' }).click();
  await standalone.locator('.story-card').filter({ hasText: 'Пока горит август' }).click();
  await standalone.waitForFunction(() => document.querySelector('.stage .text')?.textContent.length > 10);
  await standalone.screenshot({ path: `${output}/standalone.png` });
  await standalone.close();
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: reading, saves, resume, editor search, 4 viewport sizes, standalone file');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
