/* Gallery uses the story's existing background fields; no invented package fields. */
import { getArtwork } from './store.js';
import { resolveUrl } from './format.js';
import { el } from './util.js';
import { openSheet } from './ui.js';

export function openGallery(story) {
  const images = new Map(getArtwork(story.id).map(item => [item.path, item.name]));
  const grid = el('div', { class: 'gallery-grid' });
  for (const [path, name] of images) {
    const url = resolveUrl(story, path);
    grid.append(el('button', { class: 'gallery-tile', type: 'button', onclick: () => openSheet({ title: name, content: el('img', { class: 'gallery-full', src: url, alt: name }), layout: 'page' }) },
      el('img', { src: url, alt: '', loading: 'lazy' }), el('span', { text: name })));
  }
  if (!images.size) grid.append(el('p', { class: 'field-hint', text: 'Здесь появятся фоны прочитанных сцен.' }));
  return openSheet({ title: 'Галерея', subtitle: `${story.title} · Открыто сцен: ${images.size}`, content: grid, layout: 'page' });
}
