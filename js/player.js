/* VNMY — экран прохождения: мост между движком, сохранениями и меню */
import { Stage } from './engine.js';
import { openSettings } from './settings.js';
import { openGallery } from './gallery.js';
import { getSettings, getSaves, writeSave, deleteSave, getSeen, markSeen, markArtwork } from './store.js';
import { findScene, bareId, resolveUrl } from './format.js';
import { $, debounce, el, plural, deepClone } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';
import { restorePosition, storyRevision } from './session.js';

let stage = null;
let currentStory = null;
let pendingPersist = null;
let wakeLock = null;
let keyHandler = null;

/** Сколько ручных сохранений показываем в меню. */
const SLOT_IDS = ['1', '2', '3', '4', '5', '6'];

function flatPosition(story, sceneId, stepIndex) {
  let before = 0;
  for (const scene of story.scenes) {
    if (scene.id === sceneId) return before + stepIndex;
    before += scene.steps.length;
  }
  return before;
}

function totalSteps(story) {
  return story.scenes.reduce((n, s) => n + s.steps.length, 0);
}

export function openPlayer(story, opts = {}) {
  closePlayer();
  currentStory = story;
  const host = $('#player-host');
  host.innerHTML = '';

  const settings = getSettings();
  const saves = getSaves(story.id);
  // явно выбранный слот важнее автосейва; «продолжить» берёт автосейв
  const slotSave = opts.slot ? saves.slots.find((entry) => entry.slot === opts.slot) : null;
  const source = slotSave || (!opts.fresh ? saves.auto : null);
  const restored = restorePosition(story, source);
  const canResume = !!restored && (!!slotSave || !source.ended) && !!findScene(story, restored.sceneId);
  const resume = canResume
    ? {
      sceneId: restored.sceneId,
      stepIndex: restored.stepIndex,
      vars: restored.vars || {},
      visual: restored.visual,
      history: Array.isArray(restored.history) ? restored.history : [],
    }
    : { sceneId: story.scenes[0].id, stepIndex: 0, history: [] };

  if (canResume && (restored.changed || restored.relocated)) {
    toast(restored.relocated ? 'История обновилась: сохранённая реплика удалена. Открыто ближайшее место.' : 'История обновилась. Прогресс восстановлен по реплике.', 4500);
  }
  const seenBefore = getSeen(story.id);

  let finished = false;
  const persist = debounce((position, step) => {
    // после финала автосейв не перезаписываем: иначе теряется отметка «прочитано»
    if (finished || stage?.ended) return;
    if (!findScene(story, position.sceneId)) return;
    writeSave(story.id, 'auto', positionPayload(story, position, step));
  }, 350);
  pendingPersist = persist;

  stage = new Stage(host, {
    story,
    start: resume,
    vars: resume.vars,
    visual: resume.visual,
    resuming: canResume,
    history: resume.history || [],
    mode: 'play',
    settings,
    seen: new Set(seenBefore),
    seenBefore,
    onPosition: (position, step) => {
      markSeen(story.id, `${position.sceneId}:${bareId(step?.id || '')}`);
      markArtwork(story.id, position.visual?.bg, findScene(story, position.sceneId)?.name);
      persist(position, step);
    },
    onJournal: () => openJournal(story),
    onSaves: () => openSaves(story, opts),
    onRestart: () => { finished = false; persist.cancel(); },
    onMenu: () => openPlayerMenu(story, opts),
    onExit: () => opts.onExit?.(),
    onBrokenLink: (ref) => toast(`Переход «${ref}» не найден`),
    onVars: () => {
      if (stage && !stage.ended) persist(stage.position, stage.step);
    },
    onHistory: () => {
      if (stage && !stage.ended) persist(stage.position, stage.step);
    },
    onEnding: () => {
      finished = true;
      persist.cancel();
      writeSave(story.id, 'auto', {
        sceneId: stage.position.sceneId,
        sceneIndex: stage.position.sceneIndex,
        stepIndex: stage.position.stepIndex,
        sceneName: findScene(story, stage.position.sceneId)?.name || '',
        percent: 1,
        excerpt: '',
        vars: { ...stage.vars },
        history: [...stage.history],
        ended: true,
        stepId: `${stage.sceneId}:${bareId(stage.step?.id || '')}`,
        revision: storyRevision(story),
        visual: deepClone(stage.visual),
      });
    },
  });
  stage.mount();
  stage.node.style.setProperty('--accent', '#8d9af2');

  keyHandler = (e) => {
    if (document.body.classList.contains('no-scroll')) return; // открыта шторка
    if (e.defaultPrevented || e.target.closest?.('input, textarea, select, button, [contenteditable]')) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      stage?.handleTap();
    } else if (e.key === 'Escape') {
      openPlayerMenu(story, opts);
    }
  };
  document.addEventListener('keydown', keyHandler);
  requestWakeLock(settings.keepAwake);
  return stage;
}

/** Что именно запоминаем в сохранении: место, переменные, журнал. */
function positionPayload(story, position, step) {
  return {
    revision: storyRevision(story),
    visual: position.visual || deepClone(stage?.visual || {}),
    thumbnail: resolveUrl(story, (position.visual || stage?.visual)?.bg || story.cover || ''),
    sceneId: position.sceneId,
    sceneIndex: position.sceneIndex,
    stepIndex: position.stepIndex,
    stepId: `${position.sceneId}:${bareId(step?.id || '')}`,
    sceneName: findScene(story, position.sceneId)?.name || '',
    percent: Math.min(1, (flatPosition(story, position.sceneId, position.stepIndex) + 1) / Math.max(1, totalSteps(story))),
    excerpt: (step?.text || '').slice(0, 90),
    vars: position.vars || {},
    history: [...(stage?.history || [])],
    ended: !!position.ended,
  };
}

/** Короткая дата для слота: «26.10, 04:12» — в строку с процентом. */
function slotDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Убираем разметку реплики: в журнале нужен чистый текст. */
function plainLine(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1');
}

/** Журнал прочитанного: последняя реплика внизу, список сам прокручивается. */
function openJournal(story) {
  const entries = stage?.history || [];
  const list = el('div', { class: 'journal' });
  if (!entries.length) {
    list.append(el('p', { class: 'field-hint', text: 'Здесь появятся прочитанные реплики: листайте историю, и они будут копиться.' }));
  }
  for (const entry of entries) {
    list.append(el('div', { class: `journal-line${entry.choice ? ' is-choice' : ''}` },
      entry.name ? el('span', { class: 'journal-name', text: entry.name }) : null,
      el('span', { class: 'journal-text', text: plainLine(entry.text) }),
    ));
  }
  openSheet({
    layout: 'page',
    title: 'Журнал',
    subtitle: entries.length
      ? `${entries.length} ${plural(entries.length, 'реплика', 'реплики', 'реплик')} · ${story.title}`
      : story.title,
    content: list,
  });
  requestAnimationFrame(() => {
    const sheet = document.querySelector('#overlay-root .sheet');
    if (sheet) sheet.scrollTop = sheet.scrollHeight;
  });
}

/** Save and load pages share slots, with explicit actions and an auto-save tab. */
export function openSaves(story, opts = {}, mode = 'save') {
  let category = 'manual';
  let selected = mode === 'save' ? '1' : null;
  let close;
  const content = el('div', { class: 'saves-page' });
  const tabs = el('div', { class: 'reader-tabs', role: 'tablist', 'aria-label': 'Тип сохранения' });
  const list = el('div', { class: 'save-grid', id: 'save-panel', role: 'tabpanel' });
  const action = el('button', { class: 'solid-btn save-action', type: 'button' });
  function render() {
    const saves = getSaves(story.id);
    tabs.replaceChildren(); list.replaceChildren();
    for (const [id, label] of [['manual', 'Ручные'], ['auto', 'Авто']]) {
      tabs.append(el('button', { class: 'reader-tab', type: 'button', role: 'tab', id: `save-tab-${id}`, 'aria-controls': list.id, 'aria-selected': String(category === id), text: label, onclick: () => { category = id; selected = null; render(); } }));
    }
    list.setAttribute('aria-labelledby', `save-tab-${category}`);
    const entries = category === 'auto' ? [['auto', saves.auto]] : SLOT_IDS.map(slot => [slot, saves.slots.find(item => item.slot === slot)]);
    for (const [slot, entry] of entries) {
      if (mode === 'load' && !entry) continue;
      const title = slot === 'auto' ? 'Автосохранение' : `Слот ${slot}`;
      const thumbnail = entry?.visual?.bg ? resolveUrl(story, entry.visual.bg) : entry?.thumbnail;
      const cell = el('div', { class: `save-cell${selected === slot ? ' is-selected' : ''}` });
      cell.append(el('button', { class: 'save-select', type: 'button', 'aria-pressed': String(selected === slot), 'aria-label': `${title}${entry ? ': ' + entry.sceneName : ': пустой'}`, onclick: () => { selected = slot; render(); } },
        thumbnail ? el('img', { src: thumbnail, alt: '', class: 'slot-cover' }) : el('span', { class: 'slot-placeholder', text: entry ? '◇' : '+' }),
        el('strong', { text: title }), el('span', { class: 'save-slot-meta', text: entry ? `${entry.sceneName || 'Начало'} · ${slotDate(entry.at)}` : 'Пустой слот' })));
      if (entry && slot !== 'auto') cell.append(el('button', { class: 'text-btn slot-delete', type: 'button', text: 'Удалить', 'aria-label': `Удалить ${title}`, onclick: async () => {
        if (!await confirmDialog({ title: `Удалить ${title.toLowerCase()}?`, text: 'Автосохранение останется.', confirmText: 'Удалить' })) return;
        deleteSave(story.id, slot); selected = null; render();
      } }));
      list.append(cell);
    }
    if (!list.childElementCount || (category === 'auto' && !saves.auto)) {
      list.replaceChildren(el('p', { class: 'field-hint', text: category === 'auto' ? 'Автосохранение появится при чтении.' : 'Пока нет ручных сохранений.' }));
    }
    const entry = selected === 'auto' ? saves.auto : saves.slots.find(item => item.slot === selected);
    action.textContent = mode === 'save' && category === 'manual' ? 'Сохранить' : 'Загрузить';
    action.disabled = !selected || (category === 'auto' || mode === 'load' ? !entry : !stage);
  }
  action.addEventListener('click', async () => {
    if (!selected) return;
    const slot = selected;
    if (mode === 'save' && category === 'manual') {
      const entry = getSaves(story.id).slots.find(item => item.slot === slot);
      if (entry && !await confirmDialog({ title: `Перезаписать слот ${slot}?`, text: 'Предыдущее место будет заменено текущим.', confirmText: 'Сохранить', danger: false })) return;
      if (!stage || currentStory?.id !== story.id) return;
      writeSave(story.id, slot, positionPayload(story, stage.position, stage.step));
      toast(`Сохранено в слот ${slot}`); render();
    } else {
      close();
      if (opts.onLoad) opts.onLoad(slot);
      else openPlayer(story, { ...opts, slot: slot === 'auto' ? undefined : slot });
    }
  });
  render(); content.append(tabs, list, action);
  close = openSheet({ layout: 'page', title: mode === 'save' ? 'Сохранить игру' : 'Загрузить игру', subtitle: story.title, content });
  return close;
}

export function closePlayer() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  // отложенное сохранение не должно сработать после выхода и перезаписать финал
  pendingPersist?.flush?.();
  pendingPersist?.cancel?.();
  pendingPersist = null;
  stage?.destroy();
  stage = null;
  currentStory = null;
  releaseWakeLock();
}

function openPlayerMenu(story, opts) {
  stage?.node.classList.remove('ui-hidden');
  openSheet({
    title: 'Пауза',
    subtitle: `${story.title} · ${stage?.scene?.name || 'Начало'}`,
    content: close => el('button', { class: 'solid-btn pause-resume', type: 'button', text: 'Продолжить', onclick: close }),
    rows: [
      { label: 'Сохранить', icon: ICONS.save, onSelect: () => openSaves(story, opts, 'save') },
      { label: 'Загрузить', icon: ICONS.download, onSelect: () => openSaves(story, opts, 'load') },
      { label: 'Журнал', icon: ICONS.journal, onSelect: () => openJournal(story) },
      { label: 'Галерея', icon: ICONS.image, onSelect: () => openGallery(story) },
      { label: 'Настройки', icon: ICONS.dots, onSelect: () => openSettings() },
      { label: 'Скрыть интерфейс', icon: ICONS.eye, onSelect: () => stage?.node.classList.add('ui-hidden') },
      { label: 'В главное меню', icon: ICONS.back, onSelect: () => (opts.onHome || opts.onExit)?.() },
    ],
  });
}

/* ─────────────── wake lock ─────────────── */

async function requestWakeLock(enabled) {
  if (wakeLock || !enabled || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* игнорируем: некоторые браузеры требуют жест пользователя */ }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pendingPersist?.flush?.();
  if (!document.hidden && currentStory && getSettings().keepAwake) requestWakeLock(true);
});

window.addEventListener('pagehide', () => pendingPersist?.flush?.());
document.addEventListener('vnmy:modal', e => stage?.setPaused(e.detail > 0));

document.addEventListener('vnmy:settings', event => {
  stage?.applySettings(event.detail);
  if (currentStory && event.detail.keepAwake) requestWakeLock(true); else releaseWakeLock();
});
