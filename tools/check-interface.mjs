import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://vnmy.test/', pretendToBeVisual: true });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {} });
for (const key of ['window', 'document', 'localStorage', 'Image', 'Node', 'HTMLElement', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globalThis[key] = key.endsWith('AnimationFrame') ? window[key].bind(window) : window[key];
}
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const overlay = () => [...document.querySelectorAll('.sheet')].filter(node => !node.inert).at(-1);
const click = text => {
  const button = [...overlay().querySelectorAll('button')].find(node => (node.querySelector('.sheet-label')?.textContent || node.textContent).trim() === text);
  assert.ok(button, `Button ${text} must exist`); assert.equal(button.disabled, false); button.click();
};
const back = () => overlay().querySelector('[aria-label="Назад"]').click();

try {
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'page IDs must remain unique');
  const { normalizeStory, registerAssetUrls } = await import('../js/format.js');
  const { getSettings, saveSettings, getSaves, getArtwork, browserBackupData, markArtwork, saveStory } = await import('../js/store.js');
  const { openPlayer, closePlayer, openSaves } = await import('../js/player.js');
  const { openSettings, openSpriteTuner } = await import('../js/settings.js');
  const { openGallery } = await import('../js/gallery.js');
  const { openStoryDetails } = await import('../js/novels.js');
  const story = normalizeStory({ id: 'interface-fixture', title: 'История', packaged: true, characters: [{ id: 'a', name: 'A', sprites: { neutral: 'a.webp' } }, { id: 'b', name: 'B', sprites: { neutral: 'b.webp' } }], scenes: [{ id: 'cafe', name: 'Кофейня', card: false, bg: 'cafe.webp', cast: [{ char: 'a', pos: 'left', scale: .75 }, { char: 'b', pos: 'right', scale: 1.1 }], steps: [
    { id: 'first', text: 'Первая реплика' },
    { id: 'choice', text: 'Вторая реплика', choices: [{ text: 'Продолжить', goto: 'last' }] },
    { id: 'last', text: 'Последняя реплика', bg: 'evening.webp' },
    { id: 'end', text: 'Конец', end: true },
  ] }] });
  registerAssetUrls(story.id, new Map([['cafe.webp', 'blob:https://vnmy.test/current-cafe'], ['evening.webp', 'blob:https://vnmy.test/current-evening']]));
  saveSettings({ reduceMotion: true, keepAwake: false });
  let stage = openPlayer(story, { fresh: true });
  assert.equal(stage.step.id, 'first');
  assert.ok(stage.dialogue.compareDocumentPosition(stage.choiceLayer) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'choices must follow dialogue');
  assert.deepEqual(getArtwork(story.id).map(item => item.path), ['cafe.webp'], 'only displayed background unlocks');
  const closeSettings = openSettings(); await tick();
  assert.equal(stage.paused, true, 'settings must pause the reader');
  let slider = overlay().querySelector('[aria-label="Размер текста"]');
  slider.value = '1.2'; slider.dispatchEvent(new window.Event('input'));
  assert.equal(getSettings().fontSize, 1.2); assert.equal(stage.settings.fontSize, 1.2, 'settings apply to current reader');
  click('Управление');
  const motion = overlay().querySelector('[role="switch"][aria-label="Меньше анимации"]');
  motion.click(); assert.equal(getSettings().reduceMotion, false);
  motion.click(); assert.equal(getSettings().reduceMotion, true);
  closeSettings(); assert.equal(stage.paused, false);
  stage.node.querySelector('.quick-menu').click(); await tick();
  click('Скрыть интерфейс');
  assert.equal(stage.node.classList.contains('ui-hidden'), true);
  stage.handleTap(); assert.equal(stage.node.classList.contains('ui-hidden'), false);
  assert.equal(stage.step.id, 'first', 'restoring UI must not advance dialogue');

  // Zoom is a persisted reader preference, independent of authored cast and emotion frames.
  const actorsBeforeZoom = [...stage.spriteNodes.values()];
  const authoredBeforeZoom = structuredClone(stage.visual.cast);
  const closeTuner = openSpriteTuner(); await tick();
  assert.equal(stage.paused, true);
  assert.equal(stage.node.classList.contains('is-adjusting-sprites'), true);
  const zoom = overlay().querySelector('[aria-label="Масштаб персонажей"]');
  zoom.value = '1.8'; zoom.dispatchEvent(new window.Event('input'));
  assert.equal(stage.node.style.getPropertyValue('--sprite-scale'), '1.8');
  assert.equal(getSettings().spriteScale, 1.8);
  assert.deepEqual([...stage.spriteNodes.values()], actorsBeforeZoom, 'zoom must not remount actors');
  assert.deepEqual(stage.visual.cast, authoredBeforeZoom, 'zoom must not rewrite authored scale or positions');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(stage.node.classList.contains('is-adjusting-sprites'), false, 'Escape restores dialogue');
  assert.equal(stage.paused, false);
  closeTuner(); // idempotent cleanup
  const closeSceneSettings = openSettings('sprites'); await tick();
  assert.equal(overlay().querySelector('[aria-label="Масштаб персонажей"]').value, '1.8');
  click('Сбросить до 100%');
  assert.equal(getSettings().spriteScale, 1);
  assert.equal(getSettings().fontSize, 1.2, 'zoom reset must not reset text');
  closeSceneSettings();
  assert.equal(stage.node.style.getPropertyValue('--sprite-scale'), '1');
  stage.applySettings({ spriteScale: NaN });
  assert.equal(stage.node.style.getPropertyValue('--sprite-scale'), '1');
  for (const [value, expected] of [[null, 1], [Infinity, 1], [-10, .5], [99, 3]]) {
    saveSettings({ spriteScale: value }); assert.equal(getSettings().spriteScale, expected);
  }
  saveSettings({ spriteScale: 1.8 });
  stage.goTo('cafe', 1, { instant: true });
  openSaves(story); await tick();
  assert.equal(stage.paused, true);
  assert.equal(overlay().querySelectorAll('.save-cell').length, 6);
  overlay().querySelector('[aria-label="Слот 4: пустой"]').click();
  click('Сохранить'); await tick();
  assert.equal(getSaves(story.id).slots.find(item => item.slot === '4').stepId, 'cafe:choice');
  assert.deepEqual(getArtwork(story.id).map(item => item.path), ['cafe.webp']);
  back(); stage.goTo('cafe', 2, { instant: true });
  assert.equal(getArtwork(story.id).length, 2);
  closePlayer();
  stage = openPlayer(story, { slot: '4' });
  assert.equal(stage.step.id, 'choice');
  assert.equal(stage.node.style.getPropertyValue('--sprite-scale'), '1.8', 'zoom survives reopening and slot loading');
  assert.equal(stage.awaitingChoices, true, 'choices survive slot restoration');
  assert.equal(stage.history.at(-1).text, 'Вторая реплика');

  // A save thumbnail must resolve the current asset URL, never an expired blob URL.
  registerAssetUrls(story.id, new Map([['cafe.webp', 'blob:https://vnmy.test/reimported-cafe']]));
  openSaves(story, {}, 'load'); await tick();
  assert.equal(overlay().querySelector('.slot-cover').getAttribute('src'), 'blob:https://vnmy.test/reimported-cafe');
  assert.equal(overlay().querySelector('.save-action').disabled, true, 'load needs an explicit selection');
  click('Авто'); await tick();
  assert.equal(overlay().querySelector('.save-action').textContent, 'Загрузить');
  back();

  markArtwork(story.id, 'cafe.webp', 'Кофейня');
  assert.equal(getArtwork(story.id).length, 2, 'repeated scene does not duplicate artwork');
  assert.equal(browserBackupData()[`vnmy:artwork:${story.id}`].length, 2, 'backup includes artwork unlocks');
  openGallery(story); await tick();
  assert.equal(overlay().querySelectorAll('.gallery-tile').length, 2);
  overlay().querySelector('.gallery-tile').click(); await tick();
  assert.equal(document.querySelector('#screen-library').inert, true);
  back(); assert.equal(stage.paused, true, 'closing artwork keeps gallery modal paused');
  back(); assert.equal(stage.paused, false, 'closing last modal resumes reader');

  let opened = null;
  openStoryDetails(story, { onPlay: (value, opts) => { opened = { value, opts }; } }); await tick();
  click('Продолжить'); assert.equal(opened.value.id, story.id);

  // Auto-reading waits for a choice instead of choosing on the player's behalf.
  let advanced = 0;
  stage.autoReading = true;
  stage.later = fn => { stage._autoCallback = fn; };
  stage.advance = () => advanced++;
  stage.maybeAutoAdvance(stage.step);
  stage._autoCallback(); assert.equal(advanced, 0);
  stage.autoReading = false; stage.awaitingChoices = false;
  stage._autoCallback(); assert.equal(advanced, 0, 'disabled auto ignores queued callback');
  closePlayer();
  const otherStory = normalizeStory({ id: 'other-story', scenes: [{ id: 'first', card: false, steps: [{ text: 'Другая новелла' }] }] });
  const otherStage = openPlayer(otherStory);
  assert.equal(otherStage.node.style.getPropertyValue('--sprite-scale'), '1.8', 'the same zoom applies to any novel');
  closePlayer();
  console.log('Интерфейс: настройки, пауза, 6 слотов, продолжение с выбора, актуальные thumbnail URL, галерея, вложенные окна и авто — пройдено');
} finally {
  dom.window.close();
}
