import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { writeZip } from './pack.mjs';
import { StoryAudio, audioVolume } from '../js/audio.js';
import { normalizeStory, stateAt } from '../js/format.js';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://vnmy.test/', pretendToBeVisual: true });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {} });
for (const key of ['window', 'document', 'localStorage', 'Image', 'Node', 'HTMLElement', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[key] = key.endsWith('AnimationFrame') ? window[key].bind(window) : window[key];
const temp = await mkdtemp(path.join(tmpdir(), 'vnmy-features-'));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const sheet = () => [...document.querySelectorAll('.sheet')].findLast(node => !node.inert);
const click = name => {
  const button = [...sheet().querySelectorAll('button')].find(button => (button.querySelector('.sheet-label')?.textContent || button.textContent).trim() === name);
  assert.ok(button, name); button.click();
};
class FakeAudio {
  constructor() { this.paused = true; this.ended = false; this.plays = 0; }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
try {
  const raw = { id: 'audio-fixture', title: 'Звуковая история', genres: ['Мистика'], soundtrack: [{ title: 'Первый вечер', src: 'theme.wav' }], scenes: [{ id: 'cafe', card: false, bg: 'data:image/svg+xml,<svg/>', music: 'theme.wav', steps: [
    { id: 'one', text: 'Первая реплика', voice: 'voice.wav', sound: 'bell.wav' },
    { id: 'two', text: 'Выбор', choices: [{ text: 'Дальше', goto: 'stop' }] },
    { id: 'skip', text: 'Не показывать', if: 'false', music: 'secret.wav' },
    { id: 'stop', text: 'Тишина', music: '', end: true },
  ] }] };
  const story = normalizeStory(structuredClone(raw));
  assert.equal(story.scenes[0].music, 'theme.wav');
  assert.equal(story.scenes[0].steps[0].voice, 'voice.wav');
  assert.equal(stateAt(story, 'cafe', 1).music, 'theme.wav');
  assert.equal(stateAt(story, 'cafe', 3).music, '', 'empty music stops the track');
  const made = [];
  const manager = new StoryAudio(story, {}, () => { const audio = new FakeAudio(); made.push(audio); return audio; });
  manager.render({ music: 'theme.wav' }, story.scenes[0].steps[0]);
  assert.equal(manager.channels.size, 3);
  assert.equal(manager.channels.get('music').audio.loop, true);
  assert.equal(manager.channels.get('music').audio.volume, .8 * .6);
  const voice = manager.channels.get('voice').audio;
  const plays = voice.plays;
  manager.render({ music: 'theme.wav' }, story.scenes[0].steps[0], true);
  assert.equal(voice.plays, plays, 'redrawing after a modal must not replay voice');
  manager.setPaused(true); assert.equal(voice.paused, true); assert.equal(manager.channels.get('music').audio.paused, false);
  manager.setHidden(true); assert.equal(manager.channels.get('music').audio.paused, true);
  manager.applySettings({ backgroundAudio: true, masterVolume: .5, musicVolume: .4 });
  assert.equal(manager.channels.get('music').audio.paused, false); assert.equal(manager.channels.get('music').audio.volume, .2);
  manager.render({ music: '' }, { text: 'Silent' }); assert.equal(manager.channels.size, 0);
  manager.destroy(); manager.play('music', 'theme.wav'); assert.equal(manager.channels.size, 0);
  assert.equal(audioVolume({ masterVolume: NaN, musicVolume: 99 }, 'music'), .8);
  const gains = [];
  window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'running'; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    createGain() { const gain = { gain: { value: 1 }, connect() {}, disconnect() {} }; gains.push(gain); return gain; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  const routed = new StoryAudio(story, { masterVolume: .5, musicVolume: .4 }, () => new FakeAudio());
  await routed.play('music', 'theme.wav');
  assert.equal(routed.channels.get('music').audio.volume, 1);
  assert.equal(gains[0].gain.value, .2, 'Web Audio controls effective volume independently of media.volume');
  routed.destroy(); delete window.AudioContext;


  const store = await import('../js/store.js');
  const { inspectStoryFile } = await import('../js/import.js');
  const { openPlayer, closePlayer, openSaves } = await import('../js/player.js');
  const { openSettings } = await import('../js/settings.js');
  assert.ok(['theme.wav','voice.wav','bell.wav'].every(asset => store.storyAssets(story).includes(asset)), 'all audio participates in packaging');
  await writeFile(path.join(temp, 'story.json'), JSON.stringify(raw));
  const out = path.join(temp, 'fixture.vnmy');
  await writeZip([{ name: 'world/story.json', full: path.join(temp, 'story.json') }], out);
  const input = new File([await readFile(out)], 'fixture.vnmy');
  const before = store.listLocalStoryIds();
  const inspected = await inspectStoryFile(input);
  assert.equal(inspected.title, raw.title); assert.equal(inspected.hasMusic, true); assert.equal(inspected.sceneCount, 1);
  assert.deepEqual(store.listLocalStoryIds(), before, 'preview must not import any records');
  inspected.dispose();
  await assert.rejects(inspectStoryFile(new File(['{}'], 'bad.vnmy')), /BAD_PACKAGE/);
  await assert.rejects(inspectStoryFile(new File(['not json'], 'bad.json')), /BAD_JSON/);

  const quiet = normalizeStory({ id: 'quick-fixture', scenes: [{ id: 'cafe', card: false, steps: [{ id: 'one', text: 'One' }, { id: 'two', text: 'Two', choices: [{ text: 'End', goto: 'end' }] }, { id: 'end', end: true }] }] });
  store.saveSettings({ reduceMotion: true, keepAwake: false });
  let stage = openPlayer(quiet, { fresh: true });
  stage.audio.destroy(); stage.audio = new StoryAudio(quiet, store.getSettings(), () => new FakeAudio());
  stage.audio.play('music', 'track.wav');
  const closeSettings = openSettings('sound'); await tick();
  const volume = sheet().querySelector('[aria-label="Общая громкость"]');
  volume.value = '.5'; volume.dispatchEvent(new window.Event('input'));
  assert.equal(stage.audio.channels.get('music').audio.volume, .5 * .6);
  closeSettings();
  const point = { ...stage.position, stepId: 'cafe:one' };
  for (let i = 1; i <= 6; i++) store.writeSave(quiet.id, String(i), point);
  stage.goTo('cafe', 1, { instant: true });
  openSaves(quiet); await tick(); click('Быстрые');
  sheet().querySelector('[aria-label="Быстрое сохранение: пустой"]').click(); click('Сохранить'); await tick();
  assert.equal(store.getSaves(quiet.id).slots.length, 6, 'quick save cannot evict a manual slot');
  assert.equal(store.getSaves(quiet.id).quick.stepId, 'cafe:two');
  sheet().querySelector('[aria-label="Назад"]').click(); closePlayer();
  stage = openPlayer(quiet, { slot: 'quick' });
  assert.equal(stage.step.id, 'two'); assert.equal(stage.awaitingChoices, true);
  assert.equal(store.browserBackupData()['vnmy:saves:quick-fixture'].quick.stepId, 'cafe:two');
  store.markArtwork(quiet.id, 'theme.wav', 'Музыка', 'music');
  assert.equal(store.getArtwork(quiet.id).length, 0); assert.equal(store.getArtwork(quiet.id, 'music').length, 1);

  // Real gesture handlers: swipe opens journal; a long press hides UI without advancing.
  const target = stage.tapLayer;
  const pointer = (type, y) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 100, clientY: y, button: 0 }));
  pointer('pointerdown', 400); pointer('pointermove', 200); pointer('pointerup', 200);
  assert.equal(sheet().querySelector('h3').textContent, 'Журнал');
  sheet().querySelector('[aria-label="Назад"]').click();
  const position = stage.step.id;
  pointer('pointerdown', 300); await new Promise(resolve => setTimeout(resolve, 480));
  assert.equal(stage.node.classList.contains('ui-hidden'), true);
  pointer('pointerup', 300); target.click(); assert.equal(stage.step.id, position);
  stage.handleTap(); assert.equal(stage.node.classList.contains('ui-hidden'), false);
  closePlayer();
  console.log('Функции референсов: аудиоканалы/громкость/пауза, .vnmy-предпросмотр без записи, быстрый слот без потери ручных, музыка в бэкапе и жесты — пройдено');
} finally { dom.window.close(); await rm(temp, { recursive: true, force: true }); }
