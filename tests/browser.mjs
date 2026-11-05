/* VNMY — проверки в настоящем Chromium.
 *
 * В поставке больше нет игровых вселенных, поэтому тест сам создаёт вселенную
 * и новеллу через публичное хранилище приложения, а затем проверяет чтение,
 * сохранения, продолжение, редактор, четыре размера экрана и автономный файл.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const server = http.createServer(async (req, res) => {
  try {
    const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!filename.startsWith(root + path.sep) && filename !== root) { res.writeHead(403); res.end(); return; }
    const file = filename === root ? path.join(root, 'index.html') : filename;
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VNMY_CHROMIUM ? { executablePath: process.env.VNMY_CHROMIUM } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const output = process.env.VNMY_SCREENSHOTS || '/tmp/vnmy-screenshots';
await fs.mkdir(output, { recursive: true });

const UNIVERSE_TITLE = 'Тестовый мир';
const STORY_TITLE = 'Проверка чтения';
const LONG_LINE = 'Длинная реплика должна сохранять выбранный читателем размер. ';
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  /* 1. Пустая поставка: библиотека честно об этом говорит. */
  await page.goto(address);
  await page.locator('#universe-list .lib-note').waitFor();
  assert.equal(await page.locator('.universe-card').count(), 0, 'в поставке не должно быть вселенных');
  assert.match(await page.locator('#universe-list .lib-note').textContent(), /Пока нет ни одной вселенной/);
  assert.equal(await page.locator('#btn-new-universe').isVisible(), false, 'в режиме чтения кнопки создания нет');
  await page.screenshot({ path: `${output}/library-empty.png` });

  /* 2. Вселенная и новелла создаются тем же API, что и в редакторе. */
  await page.evaluate(async ({ universeTitle, storyTitle, longLine, pixel }) => {
    const store = await import('/js/store.js');
    const { createUniverse } = await import('/js/universe.js');
    store.saveUniverse(createUniverse({
      id: 'test-world',
      title: universeTitle,
      description: 'Мир для браузерных проверок.',
      accent: '#8fb8d8',
      order: 1,
    }));
    const story = store.createStory({
      id: 'browser-story',
      title: storyTitle,
      author: 'VNMY tests',
      description: 'Синтетическая история для проверок.',
      universe: 'test-world',
      scenes: [{
        id: 'long', name: 'Длинная реплика', bg: pixel,
        steps: [
          { id: 'long', text: longLine.repeat(50) },
          { id: 'end', text: 'Финал', end: true, endTitle: 'КОНЕЦ · Проверка' },
        ],
      }],
    });
    store.saveStory(story);
    store.saveSettings({ reduceMotion: true, fontSize: 1 });
    await store.flushStorage();
  }, { universeTitle: UNIVERSE_TITLE, storyTitle: STORY_TITLE, longLine: LONG_LINE, pixel: PIXEL });

  await page.reload();
  await page.locator('.universe-card').filter({ hasText: UNIVERSE_TITLE }).waitFor();
  await page.locator('.universe-card').filter({ hasText: UNIVERSE_TITLE }).click();
  await page.locator('.story-card').filter({ hasText: STORY_TITLE }).click();
  await page.waitForFunction(() => document.querySelector('.stage .text')?.textContent.length > 40);
  const background = await page.locator('.stage .bg.is-active').evaluate(async node => {
    const src = getComputedStyle(node).backgroundImage.slice(5, -2);
    const image = new Image(); image.src = src; await image.decode(); return image.naturalWidth;
  });
  assert(background > 0, 'фон сцены не открылся');
  assert(await page.locator('.stage').evaluate(node => node.classList.contains('is-reduced-motion')),
    'режим «меньше анимации» не применился');
  await page.screenshot({ path: `${output}/reading.png` });

  /* 3. Четыре размера экрана: шрифт не мельчает, текст прокручивается, вёрстка не шире окна. */
  for (const [width, height] of [[390, 844], [320, 568], [844, 390], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const metrics = await page.locator('.stage .text').evaluate(node => ({
      font: parseFloat(getComputedStyle(node).fontSize),
      height: node.clientHeight,
      scroll: node.scrollHeight,
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert(metrics.font >= 20, JSON.stringify(metrics));
    assert(metrics.height > 0, JSON.stringify(metrics));
    assert(metrics.scroll > metrics.height, JSON.stringify(metrics));
    assert(metrics.width <= metrics.viewport, JSON.stringify(metrics));
    await page.screenshot({ path: `${output}/long-${width}x${height}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  /* 4. Слот сохранения и карточка продолжения. */
  await page.locator('.quick-save').click();
  await page.getByRole('dialog', { name: 'Сохранения' }).waitFor();
  await page.locator('.save-slot-main').first().click();
  await page.locator('.save-slot.is-filled').waitFor();
  await page.screenshot({ path: `${output}/saves.png` });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
  const readText = () => page.locator('.stage .text').textContent();
  const before = await readText();
  await page.locator('.topbar-back').click();
  await page.locator('#uni-back').click();
  await page.locator('.continue-card').waitFor();
  await page.screenshot({ path: `${output}/continue.png` });
  await page.locator('.continue-card button').click();
  await page.waitForFunction(() => document.querySelector('.stage .text')?.textContent.length > 40);
  assert.equal(await readText(), before, 'продолжение вернуло не туда');
  await page.locator('.topbar-back').click();
  await page.locator('#uni-back').click();

  /* 5. Редактор: авторский режим, карта и поиск по сценарию. */
  await page.locator('#mode-author').click();
  await page.locator('.universe-card').filter({ hasText: UNIVERSE_TITLE }).click();
  await page.locator('.story-card').filter({ hasText: STORY_TITLE }).locator('.story-card-menu').click();
  await page.getByRole('button', { name: /^Редактировать/ }).click();
  await page.getByRole('button', { name: 'Карта и поиск по сценарию' }).click();
  await page.getByRole('searchbox', { name: 'Поиск по сценарию' }).fill('Финал');
  await page.locator('.story-search-results .sheet-row').first().waitFor();
  await page.screenshot({ path: `${output}/editor-search.png` });
  await page.locator('.story-search-results .sheet-row').first().click();
  await page.locator('#ed-preview .ending-title').waitFor();

  /* 6. Автономный файл тоже открывается без сети и показывает пустую библиотеку. */
  const standalone = await context.newPage();
  const standaloneErrors = [];
  standalone.on('pageerror', e => standaloneErrors.push(e.message));
  await standalone.goto(`file://${root}/vnmy.html`);
  await standalone.locator('#universe-list .lib-note').waitFor();
  assert.match(await standalone.locator('#universe-list .lib-note').textContent(), /Пока нет ни одной вселенной/);
  assert.equal(await standalone.locator('.universe-card').count(), 0, 'в автономном файле не должно быть вселенных');
  await standalone.screenshot({ path: `${output}/standalone-empty.png` });
  await standalone.locator('#mode-author').click();
  await standalone.locator('#btn-new-universe').click();
  await standalone.locator('.uni-form input.input').fill('Офлайн-мир');
  await standalone.getByRole('button', { name: 'Создать вселенную' }).click();
  await standalone.locator('#uni-title').waitFor();
  assert.equal(await standalone.locator('#uni-title').textContent(), 'Офлайн-мир', 'офлайн-вселенная не создалась');
  await standalone.close();
  assert.deepEqual(standaloneErrors, [], 'ошибки в автономном файле: ' + standaloneErrors.join(' | '));

  assert.deepEqual(errors, [], 'ошибки на странице: ' + errors.join(' | '));
  console.log('Browser checks passed: empty library, reading, four viewport sizes, saves, resume, editor search, offline standalone');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
