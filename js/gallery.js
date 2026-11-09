/* Gallery uses the story's existing background fields; no invented package fields. */
import { getArtwork } from './store.js';
import { resolveUrl } from './format.js';
import { el } from './util.js';
import { openSheet } from './ui.js';

export function openGallery(story) {
  const images = new Map(getArtwork(story.id).map(item => [item.path, item.name]));
  const available = new Set(story.scenes.flatMap(scene => [scene.bg, ...scene.steps.map(step => step.bg)]).filter(Boolean));
  for (const path of images.keys()) if (!available.has(path)) images.delete(path);
  const grid = el('div', { class: 'gallery-grid' });
  for (const [path, name] of images) {
    const url = resolveUrl(story, path);
    grid.append(el('button', { class: 'gallery-tile', type: 'button', onclick: () => openSheet({ title: name, content: el('img', { class: 'gallery-full', src: url, alt: name }), layout: 'page' }) },
      el('img', { src: url, alt: '', loading: 'lazy' }), el('span', { text: name })));
  }
  for (const path of available) if (!images.has(path)) grid.append(el('div', { class: 'gallery-locked', role: 'img', 'aria-label': 'Иллюстрация ещё не открыта', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>' }));
  if (!available.size) grid.append(el('p', { class: 'field-hint', text: 'В этой истории пока нет иллюстраций.' }));
  return openSheet({ title: 'Галерея', subtitle: story.title, content: el('div', { class: 'gallery-page' }, el('p', { class: 'gallery-count', text: `Открыто ${images.size} из ${available.size}` }), grid, el('p', { class: 'gallery-note', text: 'Открывается по ходу истории' })), layout: 'page' });
}
