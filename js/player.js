/* VNMY — экран прохождения: мост между движком, сохранениями и меню */
import { Stage } from './engine.js';
import { getSettings, saveSettings, getSaves, writeSave, getSeen, markSeen, clearSaves } from './store.js';
import { findScene, bareId } from './format.js';
import { $, debounce, el } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';

let stage = null;
let currentStory = null;
let pendingPersist = null;
let wakeLock = null;
let keyHandler = null;

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
  const sceneCount = totalSteps(story);
  const saves = getSaves(story.id);
  const resume = !opts.fresh && saves.auto && !saves.auto.ended && findScene(story, saves.auto.sceneId)
    ? { sceneId: saves.auto.sceneId, stepIndex: saves.auto.stepIndex }
    : { sceneId: story.scenes[0].id, stepIndex: 0 };

  const seenBefore = getSeen(story.id);

  let finished = false;
  const persist = debounce((position, step) => {
    // после финала автосейв не перезаписываем: иначе теряется отметка «прочитано»
    if (finished || stage?.ended) return;
    const scene = findScene(story, position.sceneId);
    if (!scene) return;
    writeSave(story.id, 'auto', {
      sceneId: position.sceneId,
      sceneIndex: position.sceneIndex,
      stepIndex: position.stepIndex,
      stepId: `${position.sceneId}:${bareId(step?.id || '')}`,
      sceneName: scene.name,
      percent: Math.min(1, (flatPosition(story, position.sceneId, position.stepIndex) + 1) / Math.max(1, sceneCount)),
      excerpt: (step?.text || '').slice(0, 90),
      ended: false,
    });
  }, 350);
  pendingPersist = persist;

  stage = new Stage(host, {
    story,
    start: resume,
    mode: 'play',
    settings,
    seen: new Set(seenBefore),
    seenBefore,
    onPosition: (position, step) => {
      markSeen(story.id, `${position.sceneId}:${bareId(step?.id || '')}`);
      persist(position, step);
    },
    onMenu: () => openPlayerMenu(story, opts),
    onExit: () => opts.onExit?.(),
    onBrokenLink: (ref) => toast(`Переход «${ref}» не найден`),
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
        ended: true,
      });
    },
  });
  stage.mount();
  stage.node.style.setProperty('--accent', story.accent || '#e0b072');

  keyHandler = (e) => {
    if (document.body.classList.contains('no-scroll')) return; // открыта шторка
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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

export function closePlayer() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  // отложенное сохранение не должно сработать после выхода и перезаписать финал
  pendingPersist?.cancel?.();
  pendingPersist = null;
  stage?.destroy();
  stage = null;
  currentStory = null;
  releaseWakeLock();
}

function openPlayerMenu(story, opts) {
  const settings = getSettings();
  const content = document.createElement('div');
  content.className = 'menu-settings';

  const speedRow = document.createElement('div');
  speedRow.className = 'field';
  speedRow.innerHTML = '<label>Скорость текста</label>';
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '6';
  speed.max = '55';
  speed.step = '1';
  speed.value = String(56 - Number(settings.textSpeed || 22));
  const speedNote = document.createElement('span');
  speedNote.className = 'range-note';
  speedNote.textContent = `${speed.value > 34 ? 'медленно' : speed.value > 18 ? 'обычно' : 'быстро'}`;
  const speedWrap = document.createElement('div');
  speedWrap.className = 'range-row';
  speedWrap.append(speed, speedNote);
  speedRow.append(speedWrap);
  speed.addEventListener('input', () => {
    const ms = 56 - Number(speed.value);
    stage?.applySettings({ textSpeed: ms });
    saveSettings({ textSpeed: ms });
    speedNote.textContent = speed.value > 34 ? 'медленно' : speed.value > 18 ? 'обычно' : 'быстро';
  });

  const sizeRow = document.createElement('div');
  sizeRow.className = 'field';
  sizeRow.innerHTML = '<label>Размер текста</label>';
  const size = document.createElement('input');
  size.type = 'range';
  size.min = '0.85';
  size.max = '1.35';
  size.step = '0.05';
  size.value = String(settings.fontSize || 1);
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'range-row';
  sizeWrap.append(el('span', { class: 'range-note', text: 'а' }), size, el('span', { class: 'range-note range-note-big', text: 'А' }));
  sizeRow.append(sizeWrap);
  size.addEventListener('input', () => {
    stage?.applySettings({ fontSize: Number(size.value) });
    saveSettings({ fontSize: Number(size.value) });
  });

  const skipRow = document.createElement('button');
  skipRow.type = 'button';
  skipRow.className = 'sheet-row';
  const skipState = getSettings().skipSeen;
  skipRow.innerHTML = `<span>Пропускать прочитанное<small>уже прочитанные реплики листаются сами</small></span>`;
  const skipSwitch = el('span', { class: 'switch', role: 'switch', 'aria-checked': String(!!skipState) });
  skipRow.append(skipSwitch);
  skipRow.addEventListener('click', () => {
    const next = !(skipSwitch.getAttribute('aria-checked') === 'true');
    skipSwitch.setAttribute('aria-checked', String(next));
    saveSettings({ skipSeen: next });
    stage?.applySettings({ skipSeen: next });
  });

  const awakeRow = document.createElement('button');
  awakeRow.type = 'button';
  awakeRow.className = 'sheet-row';
  awakeRow.innerHTML = `<span>Не гасить экран<small>пока открыта история</small></span>`;
  const awakeSwitch = el('span', { class: 'switch', role: 'switch', 'aria-checked': String(!!settings.keepAwake) });
  awakeRow.append(awakeSwitch);
  awakeRow.addEventListener('click', () => {
    const next = !(awakeSwitch.getAttribute('aria-checked') === 'true');
    awakeSwitch.setAttribute('aria-checked', String(next));
    saveSettings({ keepAwake: next });
    if (next) requestWakeLock(true); else releaseWakeLock();
  });

  content.append(speedRow, sizeRow, skipRow, awakeRow);

  openSheet({
    title: story.title,
    subtitle: `${Math.round(((stage?.position ? flatPosition(story, stage.position.sceneId, stage.position.stepIndex) + 1 : 1) / Math.max(1, totalSteps(story))) * 100)}% истории · прогресс сохраняется сам`,
    rows: [
      {
        label: 'Начать сначала',
        icon: ICONS.restart,
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Начать сначала?', text: 'Текущий прогресс этой истории сбросится.', confirmText: 'Начать сначала', danger: false });
          if (!ok) return;
          clearSaves(story.id);
          openPlayer(story, { ...opts, fresh: true });
        },
      },
      !story.readOnly ? { label: 'Редактировать', icon: ICONS.edit, hint: 'откроется редактор этой истории', onSelect: () => opts.onEdit?.(story) } : null,
      { label: 'В библиотеку', icon: ICONS.back, onSelect: () => opts.onExit?.() },
    ],
    content,
  });
}

/* ─────────────── wake lock ─────────────── */

async function requestWakeLock(enabled) {
  if (!enabled || !('wakeLock' in navigator)) return;
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
  if (!document.hidden && currentStory && getSettings().keepAwake) requestWakeLock(true);
});
