/* Preview is read-only. Only the primary Add action writes to the library. */
import { isZip, readZip } from './zip.js';
import { importPackage, importStoryFile, moveStoryToUniverse, storyAssets } from './store.js';
import { el } from './util.js';
import { openSheet, toast } from './ui.js';
import { normalizeStory } from './format.js';
import { ICONS } from './icons.js';

export async function inspectStoryFile(file) {
  let files = null, root = '', directory = '', raw, stories, directories = [];
  if (await isZip(file)) {
    files = await readZip(file);
    const markers = [...files.keys()].filter(name => /(^|\/)(universe|story)\.json$/.test(name) && !name.split('/').some(part => part.startsWith('_') || part.startsWith('.'))).sort((a, b) => a.split('/').length - b.split('/').length);
    if (!markers.length) throw new Error('BAD_PACKAGE');
    root = markers[0].replace(/[^/]*$/, '');
    const paths = files.has(root + 'universe.json')
      ? [...files.keys()].filter(name => name.startsWith(root + 'novels/') && name.slice((root + 'novels/').length).split('/').length === 2 && name.endsWith('/story.json') && !name.slice((root + 'novels/').length).startsWith('_')).sort()
      : [root + 'story.json'];
    if (!paths.length) throw new Error('BAD_PACKAGE');
    try { stories = await Promise.all(paths.map(name => files.get(name).text().then(JSON.parse))); } catch { throw new Error('BAD_JSON'); }
    raw = stories[0]; directories = paths.map(name => name.replace(/[^/]*$/, '')); directory = directories[0];
  } else {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('BAD_JSON'); }
    stories = Array.isArray(data) ? data : Array.isArray(data?.stories) ? data.stories : Array.isArray(data?.novels) ? data.novels : [data];
    raw = stories[0];
  }
  if (!raw || !stories.length || stories.some(story => !Array.isArray(story.scenes) || !story.scenes.length)) throw new Error('BAD_PACKAGE');
  let cover = '', temporary = false;
  if (typeof raw.cover === 'string') {
    if (/^(data:|https?:)/i.test(raw.cover)) cover = raw.cover;
    else if (files?.has(directory + raw.cover) && typeof URL.createObjectURL === 'function') { cover = URL.createObjectURL(files.get(directory + raw.cover)); temporary = true; }
  }
  const missingAssets = files ? stories.flatMap((story, i) => storyAssets(normalizeStory(structuredClone(story))).filter(url => !/^(data:|blob:|https?:|\/)/i.test(url) && !files.has(directories[i] + url))) : [];
  const hasMusic = stories.some(story => (story.soundtrack || []).length || story.scenes.some(scene => scene.music || (scene.steps || []).some(step => step.music)));
  return { title: String(raw.title || 'Без названия'), count: stories.length, cover, missingAssets, sceneCount: stories.reduce((sum, story) => sum + story.scenes.length, 0), hasMusic,
    commit: () => files ? importPackage(files) : importStoryFile(file),
    dispose: () => { if (temporary) { URL.revokeObjectURL(cover); temporary = false; } },
  };
}

export function openImport({ universeId = '', onImported } = {}) {
  let selected = null, sequence = 0, closed = false, busy = false;
  const content = el('div', { class: 'import-page' });
  const input = el('input', { type: 'file', accept: '.vnmy,.zip,.json,application/zip,application/json', class: 'import-file-input', 'aria-label': 'Файл истории' });
  const pick = el('button', { class: 'solid-btn import-pick', type: 'button', text: 'Выбрать файл', onclick: () => input.click() });
  const chooser = el('div', { class: 'import-drop' }, el('span', { class: 'import-file-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.file}</svg>` }), pick, input);
  const status = el('div', { class: 'import-status', role: 'status', hidden: true });
  const preview = el('div', { class: 'import-preview', hidden: true });
  const add = el('button', { class: 'solid-btn import-add', type: 'button', text: 'Добавить в библиотеку', disabled: true });
  const errorMessage = error => ({ BAD_JSON: 'Не удалось прочитать сценарий в файле.', BAD_PACKAGE: 'В файле не найдена история VNMY.', ZIP_UNSUPPORTED: 'Этот способ сжатия не поддерживается браузером.', STORAGE_FULL: 'Недостаточно места для импорта.' }[error?.message] || 'Не получилось импортировать историю.');
  async function select(file) {
    if (!file || busy) return;
    const request = ++sequence;
    selected?.dispose(); selected = null; preview.replaceChildren(); preview.hidden = true; add.disabled = true;
    status.hidden = false; status.className = 'import-status'; status.replaceChildren(el('span', { text: file.name }), el('small', { text: 'Чтение файла…' }));
    try {
      const value = await inspectStoryFile(file);
      if (closed || request !== sequence) { value.dispose(); return; }
      selected = value;
      status.replaceChildren(el('span', { class: 'sheet-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.file}</svg>` }), el('span', { class: 'import-file-copy' }, el('span', { text: file.name }), el('small', { text: value.missingAssets.length ? `Не хватает файлов: ${value.missingAssets.length}` : 'Готово к импорту' })), el('span', { class: 'import-ready', text: value.missingAssets.length ? '!' : '✓', 'aria-hidden': 'true' }));
      const checks = el('div', { class: 'import-checks' }, el('strong', { text: value.title }), el('span', { text: value.cover ? '✓ Обложка' : 'Без обложки' }), el('span', { text: `✓ Сцены: ${value.sceneCount}` }), value.hasMusic ? el('span', { text: '✓ Музыка' }) : null, value.count > 1 ? el('span', { text: `Историй в пакете: ${value.count}` }) : null);
      preview.append(value.cover ? el('img', { src: value.cover, alt: '', class: 'import-cover' }) : null, checks);
      preview.hidden = false; add.disabled = false;
    } catch (error) { if (!closed && request === sequence) { status.classList.add('is-error'); status.replaceChildren(el('span', { text: file.name }), el('small', { text: errorMessage(error) })); } }
  }
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; select(file); });
  chooser.addEventListener('dragover', event => { event.preventDefault(); });
  chooser.addEventListener('drop', event => { event.preventDefault(); select(event.dataTransfer?.files?.[0]); });
  add.addEventListener('click', async () => {
    if (!selected || busy) return;
    busy = true; add.disabled = true; pick.disabled = true; add.textContent = 'Добавление…';
    try {
      const imported = await selected.commit();
      if (universeId && !imported.universe) for (const story of imported) if (!story.universe) moveStoryToUniverse(story, universeId);
      if (!imported.length) throw new Error('BAD_PACKAGE');
      toast(imported.missing?.length ? `Импортировано. Не хватает файлов: ${imported.missing.length}` : imported.length === 1 ? `Добавлена история «${imported[0].title}»` : `Добавлено историй: ${imported.length}`);
      close(); await onImported?.(imported);
    } catch (error) { toast(errorMessage(error), 5000); }
    finally { busy = false; add.disabled = false; pick.disabled = false; add.textContent = 'Добавить в библиотеку'; }
  });
  content.append(el('p', { class: 'import-hint', text: 'Добавьте историю в формате .vnmy.' }), chooser, status, preview, add);
  const close = openSheet({ title: 'Импорт истории', content, layout: 'page', onClose: () => { closed = true; sequence++; selected?.dispose(); } });
  return close;
}
