import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Stage } from '../js/engine.js';
import { normalizeStory } from '../js/format.js';

/** Exercise real Stage DOM updates with explicitly controlled image load/decode. */
export async function checkRendering() {
  // Different sprite image widths must not change the centered actor frame.
  const css = readFileSync(new URL('../css/player.css', import.meta.url), 'utf8');
  assert.match(css, /\\.sprite\\s*\\{[^}]*width:\\s*64cqw;/s);
  assert.match(css, /\\.sprite-inner\\s*\\{[^}]*width:\\s*100%;/s);
  assert.match(css, /\\.sprite img\\s*\\{[^}]*width:\\s*100%;[^}]*object-fit:\\s*contain;[^}]*object-position:\\s*center bottom;/s);

  const dom = new JSDOM('<div id="stage"><div id="sprites"></div></div>');
  const saved = new Map(['document', 'Image', 'requestAnimationFrame'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const loads = [];
  class PendingImage {
    constructor() { loads.push(this); }
    set src(value) { this.url = value; }
    decode() { return new Promise((resolve, reject) => { this.decoded = resolve; this.decodeFailed = reject; }); }
  }
  globalThis.document = dom.window.document;
  globalThis.Image = PendingImage;
  globalThis.requestAnimationFrame = fn => fn();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const ready = async load => { load.onload(); load.decoded(); await flush(); };
  const story = normalizeStory({ id: 'sprite-check', characters: [{ id: 'a', name: 'A', sprites: {
    base: 'base.png', smile: 'smile.png', afraid: 'afraid.png', failed: 'failed.png', other: 'other.png',
  } }], scenes: [{ id: 's', steps: [{ id: 'first', text: 'Hello' }] }] });
  const stage = new Stage(document.querySelector('#stage'), { story });
  stage.mounted = true;
  stage.node = document.querySelector('#stage');
  stage.spriteLayer = document.querySelector('#sprites');
  // Keep leave-animation cleanup under test control, without timer sleeps.
  stage.later = fn => { stage._cleanup = fn; };
  const cast = sprite => [{ char: 'a', sprite, pos: 'right', scale: .85 }];
  try {
    stage.applyCast(cast('base'));
    await ready(loads.at(-1));
    const actor = stage.spriteNodes.get('a');
    const img = actor.querySelector('img');
    assert.equal(img.getAttribute('src'), 'base.png');
    const total = loads.length;
    for (let i = 0; i < 20; i++) {
      stage.invalidateRender();
      stage.applyCast(cast('base'), { speaker: i % 2 ? 'a' : null });
      assert.equal(stage.spriteNodes.get('a'), actor);
      assert.equal(img.getAttribute('src'), 'base.png');
    }
    assert.equal(loads.length, total, 'unchanged pose must not reload or remount');

    stage.applyCast(cast('smile'));
    const smile = loads.at(-1);
    for (let i = 0; i < 20; i++) { stage.invalidateRender(); stage.applyCast(cast('smile')); }
    assert.equal(loads.at(-1), smile, 'fast dialogue must preserve pending request');
    assert.equal(img.getAttribute('src'), 'base.png');
    assert.equal(img.classList.contains('is-swapping'), false);
    smile.onload();
    assert.equal(img.getAttribute('src'), 'base.png', 'load alone must not blank the old sprite');
    smile.decoded(); await flush();
    assert.equal(img.getAttribute('src'), 'smile.png');

    stage.applyCast(cast('afraid')); const stale = loads.at(-1);
    stage.applyCast(cast('base')); const current = loads.at(-1);
    await ready(stale);
    assert.equal(img.getAttribute('src'), 'smile.png', 'stale load must not replace current request');
    await ready(current);
    assert.equal(img.getAttribute('src'), 'base.png');

    stage.applyCast(cast('failed')); const failed = loads.at(-1);
    failed.onerror();
    assert.equal(img.getAttribute('src'), 'base.png', 'network failure must preserve old image');
    stage.applyCast(cast('failed')); assert.notEqual(loads.at(-1), failed);
    const retry = loads.at(-1); retry.onload(); retry.decodeFailed(); await flush();
    assert.equal(img.getAttribute('src'), 'failed.png', 'decode rejection must fall back to loaded image');

    stage.applyCast(cast('other')); const removed = loads.at(-1);
    stage.applyCast([]); assert.equal(stage.spriteNodes.size, 0, 'CG clears the character cast');
    await ready(removed);
    assert.equal(img.getAttribute('src'), 'failed.png', 'late image must not resurrect removed character');
    stage.applyCast(cast('base')); const returning = stage.spriteNodes.get('a');
    assert.notEqual(returning, actor); await ready(loads.at(-1));
    assert.equal(returning.querySelector('img').getAttribute('src'), 'base.png');

    stage.applyCast(cast('afraid')); const destroyed = loads.at(-1);
    stage.mounted = false; await ready(destroyed);
    assert.equal(returning.querySelector('img').getAttribute('src'), 'base.png', 'unmounted stage must ignore late load');
    console.log('Рендер спрайтов: 8 проверок пройдено');
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
