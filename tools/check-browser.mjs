/* Real layout regression checks. Run: npx playwright install chromium && npm run check:browser */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeZip } from './pack.mjs';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'test-results');
const temp = await mkdtemp(path.join(tmpdir(), 'vnmy-browser-fixture-'));
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.waitForFunction(() => window.__VNMY_BOOTED && document.body.dataset.screen === 'library');
  await page.evaluate(async () => {
    const { normalizeStory } = await import('/js/format.js');
    const { saveSettings, writeSave } = await import('/js/store.js');
    const { openPlayer } = await import('/js/player.js');
    const sprite = color => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="700"><circle cx="150" cy="100" r="65" fill="${color}"/><path d="M90 170h120l30 480H60z" fill="${color}"/></svg>`);
    const bg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="900"><rect width="500" height="900" fill="#303d54"/><path d="M0 600L500 450V900H0Z" fill="#4a5362"/></svg>');
    // Synthetic rendering fixture, not a bundled novel or replacement for user artwork.
    const story = normalizeStory({ id: 'browser-fixture', title: 'Проверка сцены', characters: ['a', 'b', 'c'].map((id, i) => ({ id, name: ['Мия', 'Артём', 'Лена'][i], sprites: { neutral: sprite(['#c99883', '#8799bb', '#9ea785'][i]), smile: sprite('#d0a18e') } })), scenes: [{ id: 'cafe', name: 'Кофейня', card: false, bg, cast: [{ char: 'a', pos: 'left', scale: .65 }, { char: 'b', pos: 'right', scale: .65 }], steps: [
      { id: 'one', speaker: 'a', text: 'Я оставила тебе чашку кофе.' },
      { id: 'two', speaker: 'b', text: 'Спасибо! У нас сегодня гости.', cast: [{ char: 'a', pos: 'left', scale: .65 }, { char: 'b', pos: 'right', scale: .65 }, { char: 'c', pos: 'center', scale: .65 }] },
      { id: 'three', speaker: 'a', spriteOverride: 'smile', text: 'Как поступить?', choices: [{ text: 'Мы можем сами вещи отнести. Нас хватает.', goto: 'last' }, { text: 'Я пока пешком обучен. До лодки не дошёл.', goto: 'last' }, { text: 'Не вмешиваться', goto: 'last' }] },
      { id: 'last', text: 'Длинная реплика. '.repeat(80) }, { id: 'end', text: 'До встречи!', end: true },
    ] }] });
    for (const slot of ['1','2']) writeSave(story.id, slot, { scene: 'cafe', step: 0, sceneName: 'Кофейня', visual: { bg }, thumbnail: bg });
    saveSettings({ reduceMotion: true, fontSize: 1, keepAwake: false, spriteScale: 1 });
    document.querySelector('#screen-library').hidden = true;
    document.querySelector('#screen-player').hidden = false;
    window.testStage = openPlayer(story, { fresh: true });
  });
  await page.waitForSelector('.sprite img[src]');
  const geometry = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.locator('.sprite:not(.is-leaving)').evaluateAll(nodes => Object.fromEntries(nodes.map(node => {
    const r = node.getBoundingClientRect(); return [node.dataset.char, { center: r.x + r.width / 2, bottom: r.bottom, width: r.width, height: r.height, position: node.dataset.pos }];
  })));
  };
  const original = await geometry();
  await page.getByRole('button', { name: 'Меню игры', exact: true }).click();
  await page.getByRole('button', { name: /Масштаб персонажей/ }).click();
  const slider = page.getByRole('slider', { name: 'Масштаб персонажей', exact: true });
  await slider.evaluate(node => { node.value = '1.5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.dialogue-layer')).opacity === '0');
  const zoomed = await geometry();
  console.log('Sprite zoom geometry', JSON.stringify({ original, zoomed, css: await page.locator('.stage').evaluate(node => ({ zoom: node.style.getPropertyValue('--sprite-scale'), transform: getComputedStyle(node.querySelector('.sprite')).transform })) }));
  await page.screenshot({ path: path.join(output, 'sprite-zoom-390.png') });
  for (const id of ['a', 'b']) {
    assert.ok(Math.abs(zoomed[id].center - original[id].center) < 1, 'zoom preserves horizontal anchor');
    assert.ok(Math.abs(zoomed[id].bottom - original[id].bottom) < 1, 'zoom preserves foot anchor');
    assert.ok(Math.abs(zoomed[id].height / original[id].height - 1.5) < .01, 'slider scales the actor in actual CSS');
  }
  await page.screenshot({ path: path.join(output, 'sprite-zoom-390.png') });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.evaluate(() => window.testStage.goTo('cafe', 1, { instant: true }));
  const three = await geometry();
  assert.equal(Object.keys(three).length, 3);
  assert.deepEqual(three.a, zoomed.a); assert.deepEqual(three.b, zoomed.b);
  await page.evaluate(() => window.testStage.goTo('cafe', 2, { instant: true }));
  assert.deepEqual(await geometry(), three, 'speaker and emotion changes do not move frames');
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await geometry(); // viewport-relative CSS units settle on the next animation frame
    const layout = await page.evaluate(() => {
      const r = document.querySelector('.stage').getBoundingClientRect();
      const toolbar = document.querySelector('.quick-actions').getBoundingClientRect();
      const panel = document.querySelector('.dialogue-layer');
      const choices = [...document.querySelectorAll('.choice')];
      return { stageBottom: r.bottom, height: r.height, viewportHeight: innerHeight, viewportWidth: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth, toolbarFits: toolbar.bottom <= r.bottom + 1 && toolbar.top >= r.top,
        panelBottom: panel.getBoundingClientRect().bottom, toolbarTop: toolbar.top,
        choiceAfterText: choices[0].getBoundingClientRect().top >= document.querySelector('.dialogue').getBoundingClientRect().bottom - 1,
        panelFits: panel.getBoundingClientRect().bottom <= toolbar.top + 1,
      };
    });
    console.log('Viewport geometry', JSON.stringify({ viewport, layout }));
    await page.screenshot({ path: path.join(output, `scene-${viewport.width}.png`) });
    assert.equal(layout.overflow, false); assert.equal(layout.toolbarFits, true); assert.equal(layout.choiceAfterText, true); assert.equal(layout.panelFits, true);
    if (viewport.width < 760) assert.ok(Math.abs(layout.height - layout.viewportHeight) < 1, 'mobile stage must fill viewport without letterboxing');
    await page.screenshot({ path: path.join(output, `scene-${viewport.width}.png`) });
    // At least the last choice remains reachable via the scrollable dialogue panel.
    await page.getByRole('button', { name: 'Не вмешиваться', exact: true }).scrollIntoViewIfNeeded();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await geometry();
  await page.getByRole('button', { name: 'Меню игры', exact: true }).click();
  await page.waitForFunction(() => { const node = document.querySelector('.sheet-pause:not([aria-hidden])'); return node && getComputedStyle(node).opacity === '1'; });
  await page.screenshot({ path: path.join(output, 'pause-390.png') });
  await page.getByRole('button', { name: /Настройки/ }).click();
  await page.waitForFunction(() => { const node = document.querySelector('.sheet-page:not([aria-hidden])'); return node && getComputedStyle(node).opacity === '1'; });
  await page.screenshot({ path: path.join(output, 'settings-390.png') });
  const rowHeights = await page.locator('.setting-range').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.ok(rowHeights.every(height => height <= 100), 'settings must not have oversized slider rows');
  await page.getByRole('button', { name: 'Масштаб персонажей', exact: true }).click();
  await page.getByRole('dialog', { name: 'Масштаб персонажей', exact: true }).getByRole('slider', { name: 'Масштаб персонажей', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.stage').classList.contains('is-adjusting-sprites'));
  // Inspect every reference screen, and import an actual .vnmy before writing to the library.
  const show = async action => { await page.evaluate(action); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
  const capture = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast.is-visible'));
    await page.getByRole('dialog').last().click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(() => { const node = [...document.querySelectorAll('.sheet')].findLast(n => !n.inert); return node && node.classList.contains('is-visible') && getComputedStyle(node).opacity === '1'; });
    await page.screenshot({ path: path.join(output, name + '.png') });
  };
  const dismiss = async () => { await page.keyboard.press('Escape'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
  await show(async () => { const { openSettings } = await import('/js/settings.js'); openSettings('sound'); });
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Текст','Звук','Управление']);
  assert.equal(await page.getByRole('slider').count(), 4);
  await page.getByRole('slider', { name: 'Общая громкость', exact: true }).evaluate(node => { node.value = '.5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.evaluate(async () => (await import('/js/store.js')).getSettings().masterVolume), .5);
  await page.getByRole('button', { name: 'Проверить звук', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.test-sound').disabled);
  await capture('reference-sound-390');
  await page.getByRole('tab', { name: 'Управление', exact: true }).click();
  assert.equal(await page.locator('.gesture-row').count(), 3);
  await capture('reference-controls-390'); await dismiss();
  await show(async () => { const { openSaves } = await import('/js/player.js'); openSaves(window.testStage.story); });
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Ручные','Авто','Быстрые']);
  await page.getByRole('button', { name: 'Слот 3: пустой', exact: true }).click();
  await capture('reference-save-390');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('tab', { name: 'Быстрые', exact: true }).click();
  await page.getByRole('button', { name: 'Быстрое сохранение: пустой', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(async () => !!(await import('/js/store.js')).getSaves('browser-fixture').quick);
  await dismiss();
  await show(async () => { const { openSaves } = await import('/js/player.js'); openSaves(window.testStage.story, {}, 'load'); });
  await page.getByRole('tab', { name: 'Авто', exact: true }).click();
  await capture('reference-load-390'); await dismiss();
  await page.getByRole('button', { name: 'Журнал', exact: true }).click(); await capture('reference-journal-390'); await dismiss();

  // Create a small stored ZIP outside the repository. No novels or binary test assets are committed.
  const wav = Buffer.alloc(44 + 3200); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  for (let i = 0; i < 1600; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 2000), 44 + i * 2);
  const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#26334c"/><stop offset="1" stop-color="#a47456"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><path d="M0 300L200 170 400 290 600 120V400H0Z" fill="#182532"/><circle cx="490" cy="100" r="35" fill="#f3c98d"/></svg>';
  const raw = { id: 'import-ui-fixture', title: 'Проверка импорта', description: 'История с обложкой, сценами и музыкой.', genres: ['Мистика','Повседневность'], cover: 'cover.svg', soundtrack: [{ title: 'Первый вечер', src: 'theme.wav' }], scenes: [{ id: 'cafe', name: 'Вечер', act: 'Глава 1', card: false, bg: 'cover.svg', music: 'theme.wav', steps: [{ id: 'one', text: 'Вечер начинается.' }, { id: 'end', text: 'До встречи!', end: true }] }] };
  await writeFile(path.join(temp, 'story.json'), JSON.stringify(raw)); await writeFile(path.join(temp, 'cover.svg'), poster); await writeFile(path.join(temp, 'theme.wav'), wav);
  const packagePath = path.join(temp, 'fixture.vnmy');
  await writeZip(['story.json','cover.svg','theme.wav'].map(name => ({ name, full: path.join(temp, name) })), packagePath);
  await show(async () => { const { openImport } = await import('/js/import.js'); openImport({ onImported: stories => { window.importedStories = stories; } }); });
  await page.locator('.import-file-input').setInputFiles(packagePath);
  await page.getByText('Готово к импорту', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/js/store.js')).listLocalStoryIds().includes('import-ui-fixture')), false);
  await capture('reference-import-390');
  await page.getByRole('button', { name: 'Добавить в библиотеку', exact: true }).click();
  await page.waitForFunction(() => !!window.importedStories?.length);
  assert.equal(await page.evaluate(async () => (await import('/js/store.js')).listLocalStoryIds().includes('import-ui-fixture')), true);
  await show(async () => { const { openStoryDetails } = await import('/js/novels.js'); openStoryDetails(window.importedStories[0], { onPlay: async story => { const { openPlayer } = await import('/js/player.js'); window.testStage = openPlayer(story); } }); });
  await capture('reference-story-390');
  await page.getByRole('button', { name: 'Начать историю', exact: true }).click();
  await page.waitForFunction(() => window.testStage.story.id === 'import-ui-fixture');
  await page.waitForFunction(() => window.testStage.audio.channels.get('music')?.audio.readyState >= 2);
  assert.equal(await page.evaluate(() => window.testStage.audio.channels.get('music').audio.error), null);
  await show(async () => { const { openGallery } = await import('/js/gallery.js'); openGallery(window.testStage.story, { audio: window.testStage.audio }); });
  await capture('reference-gallery-390');
  await page.getByRole('tab', { name: 'Музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Первый вечер', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.music-row[aria-pressed="true"]'));
  await capture('reference-music-390'); await dismiss();
  assert.deepEqual(errors, []);
  console.log('Browser layout: 4 viewports, sprite zoom/anchors, 3 actors, choices, compact settings, pause and tuner cleanup passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
