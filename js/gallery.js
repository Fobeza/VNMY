import { getArtwork, getSettings } from './store.js';
import { resolveUrl } from './format.js';
import { el } from './util.js';
import { openSheet, toast } from './ui.js';
import { StoryAudio } from './audio.js';
import { ICONS } from './icons.js';

export function openGallery(story, { audio: readerAudio } = {}) {
  let active = 'images', playing = null, closed = false, request = 0;
  const preview = new StoryAudio(story, getSettings());
  const content = el('div', { class: 'gallery-page' });
  const tabs = el('div', { class: 'reader-tabs', role: 'tablist', 'aria-label': 'Раздел галереи' });
  const panel = el('div', { class: 'gallery-panel', id: 'gallery-panel', role: 'tabpanel' });
  const stop = () => { request++; preview.stop('music'); playing = null; readerAudio?.suspendMusic(false); };
  const onSettings = event => preview.applySettings(event.detail);
  const onVisibility = () => preview.setHidden(document.hidden);
  document.addEventListener('vnmy:settings', onSettings);
  document.addEventListener('visibilitychange', onVisibility);
  function render() {
    tabs.replaceChildren(); panel.replaceChildren();
    for (const [id, title] of [['images', 'Иллюстрации'], ['music', 'Музыка']]) tabs.append(el('button', { class: 'reader-tab', type: 'button', role: 'tab', 'aria-selected': String(active === id), id: `gallery-tab-${id}`, 'aria-controls': panel.id, text: title, onclick: () => { stop(); active = id; render(); } }));
    panel.setAttribute('aria-labelledby', `gallery-tab-${active}`);
    const available = active === 'images'
      ? new Set(story.scenes.flatMap(scene => [scene.bg, ...scene.steps.map(step => step.bg)]).filter(Boolean))
      : new Set([...(story.soundtrack || []).map(t => t.src), ...story.scenes.flatMap(scene => [scene.music, ...scene.steps.map(step => step.music)])].filter(Boolean));
    const opened = new Map(getArtwork(story.id, active === 'images' ? 'image' : 'music').filter(item => available.has(item.path)).map(item => [item.path, item.name]));
    panel.append(el('p', { class: 'gallery-count', text: `Открыто ${opened.size} из ${available.size}` }));
    const grid = el('div', { class: active === 'images' ? 'gallery-grid' : 'music-list' });
    for (const [path, title] of opened) {
      const url = resolveUrl(story, path);
      if (active === 'images') grid.append(el('button', { class: 'gallery-tile', type: 'button', onclick: () => openSheet({ title, content: el('img', { class: 'gallery-full', src: url, alt: title }), layout: 'page' }) }, el('img', { src: url, alt: '', loading: 'lazy' }), el('span', { text: title })));
      else grid.append(el('button', { class: 'music-row', type: 'button', 'aria-pressed': String(playing === path), onclick: async event => {
        if (playing === path) { stop(); render(); return; }
        stop(); const current = request; readerAudio?.suspendMusic(true); event.currentTarget.disabled = true;
        const success = await preview.play('music', path, { loop: true });
        if (closed || current !== request) return;
        if (success) playing = path; else { stop(); toast('Не удалось воспроизвести дорожку'); }
        render();
      } }, el('span', { class: 'sheet-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${playing === path ? '<path d="M8 5v14M16 5v14"/>' : ICONS.play}</svg>` }), el('span', { text: story.soundtrack?.find(t => t.src === path)?.title || title })));
    }
    for (const path of available) if (!opened.has(path)) grid.append(el('div', { class: active === 'images' ? 'gallery-locked' : 'music-row is-locked', role: 'img', 'aria-label': active === 'images' ? 'Иллюстрация ещё не открыта' : 'Музыка ещё не открыта', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>' }));
    if (!available.size) grid.append(el('p', { class: 'field-hint', text: active === 'images' ? 'В этой истории пока нет иллюстраций.' : 'В этой истории пока нет музыки.' }));
    panel.append(grid, el('p', { class: 'gallery-note', text: 'Открывается по ходу истории' }));
  }
  render(); content.append(tabs, panel);
  return openSheet({ title: 'Галерея', subtitle: story.title, content, layout: 'page', onClose: () => { closed = true; stop(); preview.destroy(); document.removeEventListener('vnmy:settings', onSettings); document.removeEventListener('visibilitychange', onVisibility); } });
}
