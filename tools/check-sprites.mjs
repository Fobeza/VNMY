import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { normalizeStory } from '../js/format.js';

export async function checkSprites() {
  const dom = new JSDOM(await fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    { url: 'https://vnmy.test/', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {} });
  for (const key of ['window', 'document', 'localStorage', 'Image', 'Node', 'HTMLElement',
    'requestAnimationFrame', 'cancelAnimationFrame']) {
    globalThis[key] = typeof window[key] === 'function' && key.endsWith('AnimationFrame')
      ? window[key].bind(window) : window[key];
  }
  const { Stage } = await import('../js/engine.js');
  const story = normalizeStory({ id: 'sprite-regression', characters: [{ id: 'a', name: 'A',
    sprites: { neutral: 'a.webp', smile: 'b.webp' } }], scenes: [{ id: 'scene',
    cast: [{ char: 'a', sprite: 'neutral', pos: 'left' }], steps: [
      { id: 'first', text: 'One', speaker: 'a' },
      { id: 'same', text: 'Two', speaker: 'a' },
      { id: 'change', text: 'Three', speaker: 'a', spriteOverride: 'smile' },
      { id: 'back', text: 'Four', speaker: 'a' },
    ] }] });
  const host = window.document.getElementById('player-host');
  const stage = new Stage(host, { story, settings: { textSpeed: 0 } });
  let checks = 0;
  try {
    stage.mount();
    const node = stage.spriteNodes.get('a');
    const img = node.querySelector('img');
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
    let assignments = 0;
    Object.defineProperty(img, 'src', { get() { return descriptor.get.call(this); },
      set(value) { assignments++; descriptor.set.call(this, value); } });
    stage.goTo('scene', 1);
    assert.equal(stage.spriteNodes.get('a'), node);
    assert.equal(assignments, 0);
    assert.equal(img.classList.contains('is-swapping'), false); checks++;

    stage.goTo('scene', 2);
    assert.equal(img.classList.contains('is-swapping'), true);
    stage.goTo('scene', 3);
    assert.equal(img.getAttribute('src'), 'a.webp');
    assert.equal(img.dataset.src, 'a.webp');
    assert.equal(img.classList.contains('is-swapping'), false);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(assignments, 0); checks++;

    stage.goTo('scene', 2);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(img.getAttribute('src'), 'b.webp');
    assert.equal(img.classList.contains('is-swapping'), false);
    assert.equal(assignments, 1); checks++;

    stage.setPaused(true); stage.setPaused(false);
    assert.equal(img.getAttribute('src'), 'b.webp');
    assert.equal(img.classList.contains('is-swapping'), false);
    assert.equal(assignments, 1); checks++;
    return checks;
  } finally { stage.destroy(); dom.window.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`Проверок спрайтов: ${await checkSprites()}`);
