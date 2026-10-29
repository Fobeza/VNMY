import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { APP_VERSION } from '../js/version.js';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { validateStories } from '../tools/validate.mjs';

const code = (await build({ stdin: { contents: `
import { Stage } from './js/engine.js';
import * as player from './js/player.js';
import * as store from './js/store.js';
import * as ui from './js/ui.js';
import * as format from './js/format.js';
import * as persistence from './js/persistence.js';
import * as library from './js/library.js';
import * as novels from './js/novels.js';
window.audit = { Stage, player, store, ui, format, persistence, library, novels };`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false })).outputFiles[0].text;
const html = (await fs.readFile('index.html', 'utf8')).replace(/<script>[\s\S]*?<\/script>/g, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
async function test(name, run) {
  await run(); count++; console.log(`✓ regression: ${name}`);
}
function harness({ idb, legacy } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/CSS|scrollTo/.test(e.message)) errors.push(e); });
  const dom = new JSDOM(html, { url: 'https://vnmy.test/', pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLAnchorElement.prototype.click = () => {};
      w.matchMedia = () => ({ matches: false });
      if (idb) w.indexedDB = idb;
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (obj, key) => obj[key] || (() => {}) });
      for (const [key, value] of Object.entries(legacy || {})) w.localStorage.setItem(key, JSON.stringify(value));
    },
  });
  dom.window.eval(code);
  const w = dom.window;
  const a = w.audit;
  function story(overrides = {}) {
    return a.format.normalizeStory({ id: 'regression', title: 'Regression', vars: [{ name: 'score', type: 'number', initial: 0 }], scenes: [{ id: 's', bg: 'base.webp', steps: [{ id: 'a', text: 'first {score}' }, { id: 'b', text: 'second {score}' }, { id: 'c', text: 'end', end: true }] }], ...overrides });
  }
  return { w, a, story, errors, close() { a.player.closePlayer(); dom.window.close(); } };
}
const h = harness();
const { w, a } = h;
const host = w.document.getElementById('player-host');
function isolated(story, opts = {}) { return new a.Stage(host, { story, mode: 'play', ...opts }).mount(); }

await test('new game applies first-step effects once; restore never repeats them', async () => {
  w.localStorage.clear();
  const story = h.story(); story.scenes[0].steps[0].set = [{ var: 'score', op: 'add', value: 2 }];
  let stage = a.player.openPlayer(story, { fresh: true });
  assert.equal(stage.vars.score, 2);
  a.player.closePlayer();
  stage = a.player.openPlayer(story);
  assert.equal(stage.vars.score, 2);
  assert.equal(stage.textEl.textContent, 'first 2');
  a.player.closePlayer();
});
await test('new game skips a false initial condition', async () => {
  const story = h.story(); story.scenes[0].steps[0].if = 'false';
  const stage = isolated(story); assert.equal(stage.step.id, 'b'); stage.destroy();
});
await test('stable IDs survive inserted steps and preserve variables and choices', async () => {
  w.localStorage.clear(); const story = h.story();
  story.scenes[0].steps[1].choices = [{ text: 'secret', goto: 's:c', if: 'score >= 5' }];
  a.store.writeSave(story.id, 'auto', { sceneId: 's', stepIndex: 0, stepId: 's:b', vars: { score: 5 } });
  const stage = a.player.openPlayer(story);
  assert.equal(stage.step.id, 'b'); assert.equal(stage.vars.score, 5);
  assert.equal(stage.textEl.textContent, 'second 5');
  assert.equal(stage.choiceLayer.querySelectorAll('button').length, 1);
  a.player.closePlayer();
});
await test('restart after ending re-enables autosave', async () => {
  w.localStorage.clear(); const story = h.story(); const stage = a.player.openPlayer(story, { fresh: true });
  stage.goTo('s', 2, { instant: true });
  assert.equal(a.store.getSaves(story.id).auto.ended, true);
  stage.restart(); a.player.closePlayer();
  assert.equal(a.store.getSaves(story.id).auto.ended, false);
  assert.equal(a.store.getSaves(story.id).auto.stepId, 's:a');
});
await test('fast exit and pagehide flush the latest position', async () => {
  w.localStorage.clear(); const story = h.story();
  let stage = a.player.openPlayer(story, { fresh: true }); stage.goTo('s', 1, { instant: true }); a.player.closePlayer();
  assert.equal(a.store.getSaves(story.id).auto.stepId, 's:b');
  stage = a.player.openPlayer(story); stage.goTo('s', 0, { instant: true }); w.dispatchEvent(new w.Event('pagehide'));
  assert.equal(a.store.getSaves(story.id).auto.stepId, 's:a'); a.player.closePlayer();
});
await test('old pause callback cannot replace the new dialogue', async () => {
  const story = h.story(); story.scenes[0].steps[0].pause = 50;
  const stage = isolated(story, { instantFirst: false }); stage.goTo('s', 1, { instant: true });
  await sleep(90); assert.equal(stage.textEl.textContent, 'second 0'); stage.destroy();
});
await test('skipped conditional and jumped-over steps do not alter visuals', async () => {
  const story = h.story(); story.scenes[0].steps[0].bg = 'hidden.webp'; story.scenes[0].steps[0].if = 'false';
  const stage = isolated(story); assert.equal(stage.visual.bg, 'base.webp'); stage.destroy();
  const second = h.story(); second.scenes[0].steps.splice(1, 0, { id: 'hidden', text: 'skip', bg: 'hidden.webp' });
  const stage2 = isolated(second); stage2.goTo('s', 2, { instant: true }); assert.equal(stage2.visual.bg, 'base.webp'); stage2.destroy();
});
await test('out-of-order image loads cannot paint an old background', async () => {
  const images = []; const Native = w.Image;
  w.Image = class { constructor() { images.push(this); } };
  const story = h.story(); story.scenes[0].steps[1].bg = 'b.webp'; story.scenes[0].steps[2].bg = 'c.webp'; story.scenes[0].steps[2].end = false;
  const stage = isolated(story); stage.goTo('s', 1); stage.goTo('s', 2);
  images[1].onload(); images[0].onload();
  const visible = [...stage.node.querySelectorAll('.bg.is-active')].map(n => n.style.backgroundImage).join();
  assert(visible.includes('c.webp')); assert(!visible.includes('b.webp')); stage.destroy(); w.Image = Native;
});
await test('one keyboard press advances one step', async () => {
  w.localStorage.clear(); const stage = a.player.openPlayer(h.story(), { fresh: true });
  stage.tapLayer.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(stage.index, 1); assert.equal(stage.isTyping(), true); a.player.closePlayer();
});
await test('initial weather is initialized and ask refreshes interpolation', async () => {
  const story = h.story({ vars: [{ name: 'name', type: 'text', initial: '' }], characters: [{ id: 'hero', name: '{name}', sprites: {} }] });
  story.scenes[0].weather = 'rain'; story.scenes[0].steps[0].ask = { var: 'name' }; story.scenes[0].steps[0].text = 'Hello {name}'; story.scenes[0].steps[0].speaker = 'hero';
  const stage = isolated(story); assert.equal(stage.weather.kind, 'rain'); assert(stage.weather.particles.length > 0);
  stage.askInput.value = 'Masha'; stage.submitAsk();
  assert.equal(stage.textEl.textContent, 'Hello Masha'); assert.equal(stage.speakerEl.textContent, 'Masha'); stage.destroy();
});
await test('dialogs pause the story, isolate focus, and restore it after nested Escape', async () => {
  w.localStorage.clear(); const stage = a.player.openPlayer(h.story(), { fresh: true }); stage.tapLayer.focus();
  const close = a.ui.openSheet({ title: 'Parent', content: w.document.createElement('input') });
  assert.equal(stage.paused, true); assert.equal(w.document.getElementById('screen-player').inert, true);
  const confirmation = a.ui.confirmDialog({ title: 'Child?' });
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await confirmation, false); assert.equal(stage.paused, true);
  close(); assert.equal(stage.paused, false); assert.equal(w.document.getElementById('screen-player').inert, false);
  a.player.closePlayer();
});
await test('backup includes built-in saves and maps restored local story IDs', async () => {
  w.localStorage.clear();
  const story = h.story(); story.scenes[0].bg = ''; a.store.saveStory(story); a.store.writeSave(story.id, '1', { sceneId: 's', stepIndex: 1, vars: { score: 7 } });
  a.store.writeSave('builtin-story', 'auto', { sceneId: 'x', stepIndex: 0 }); a.store.markSeen('builtin-story', 'x:a');
  let blob; w.URL.createObjectURL = value => { blob = value; return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
  await a.store.exportBackup();
  const json = await new Promise(resolve => { const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
  const imported = await a.store.importStoryFile(new w.File([json], 'backup.json'));
  assert.notEqual(imported[0].id, story.id);
  assert.equal(a.store.getSaves(imported[0].id).slots[0].vars.score, 7);
  assert.equal(a.store.getSaves('builtin-story').auto.sceneId, 'x'); assert(a.store.getSeen('builtin-story').has('x:a'));
});
await test('overlapping library renders keep only the latest result', async () => {
  w.localStorage.clear();
  const originalFetch = w.fetch;
  let release; let calls = 0;
  const firstResponse = new Promise(resolve => { release = resolve; });
  w.fetch = async () => {
    calls++;
    if (calls === 1) return firstResponse;
    return { ok:true, json: async () => ({ universes:[{ id:'render-world', dir:'render-world', title:'Latest world', novels:[] }] }) };
  };
  const first=a.library.renderLibrary({});
  const second=a.library.renderLibrary({});
  await second;
  release({ ok:true, json:async()=>({ universes:[{ id:'render-world', dir:'render-world', title:'Stale world', novels:[] }] }) });
  await first;
  const cards=w.document.querySelectorAll('#universe-list .universe-card');
  assert.equal(cards.length,1); assert(cards[0].textContent.includes('Latest world'));
  w.fetch=originalFetch;
});
assert.equal(h.errors.length, 0, h.errors.map(e => e.message).join('\n'));
h.close();

await test('IndexedDB migration commits before removing legacy data; reload retains large stories', async () => {
  const idb = new IDBFactory();
  const legacyStory = { id: 'large', title: 'Large', scenes: [{ id: 's', steps: [{ id: 'a', text: 'ok' }] }] };
  let env = harness({ idb, legacy: { 'vnmy:index': ['large'], 'vnmy:story:large': legacyStory } });
  await env.a.persistence.initializeStorage();
  assert.equal(env.a.persistence.storageBackend(), 'IndexedDB'); assert.equal(env.w.localStorage.getItem('vnmy:story:large'), null);
  const large = env.a.store.loadLocalStory('large'); large.cover = 'data:image/webp;base64,' + 'A'.repeat(6 * 1024 * 1024);
  env.a.store.saveStory(large); await env.a.persistence.flushStorage(); env.close();
  env = harness({ idb, legacy: { 'vnmy:index': ['large'] } }); await env.a.persistence.initializeStorage();
  assert.equal(env.a.store.loadLocalStory('large').cover.length, large.cover.length); env.close();
});
await test('build validation rejects broken links and missing assets', async () => {
  await assert.rejects(validateStories([{ dir: 'test', universe: { id: 'test' }, novels: [{ dir: 'novel', story: { id: 'broken', scenes: [{ id: 's', steps: [{ id: 'a', text: 'bad', goto: 'missing' }] }] } }] }]), /ведёт в никуда/);
  await assert.rejects(validateStories([{ dir: 'test', universe: { id: 'test' }, novels: [{ dir: 'novel', story: { id: 'broken', cover: 'missing.webp', scenes: [{ id: 's', steps: [{ id: 'a', text: 'end', end: true }] }] } }] }]), /missing.webp/);
});
await test('service worker preserves unrelated caches and rejects incomplete shell updates', async () => {
  const events = {}; const deleted = []; let skipped = false; let operation;
  const self = { addEventListener: (key, fn) => { events[key] = fn; }, skipWaiting: () => { skipped = true; }, clients: { claim() {} } };
  const caches = {
    keys: async () => ['vnmy-2.0-shell', `vnmy-${APP_VERSION}-shell`, 'another-app-cache'],
    delete: async key => { deleted.push(key); },
    open: async () => ({ addAll: async () => { throw new Error('offline update'); } }),
  };
  vm.runInNewContext(await fs.readFile('sw.js', 'utf8'), { self, caches, Request: class { constructor(url) { this.url = url; } } });
  events.activate({ waitUntil(promise) { operation = promise; } }); await operation;
  assert.deepEqual(deleted, ['vnmy-2.0-shell']);
  events.install({ waitUntil(promise) { operation = promise; } }); await assert.rejects(operation, /offline update/); assert.equal(skipped, false);
});
console.log(`Regression checks passed: ${count}`);
