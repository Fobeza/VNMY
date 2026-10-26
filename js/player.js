/* VNMY — экран прохождения: мост между движком, сохранениями и меню */
import { Stage } from './engine.js';
import { getSettings, saveSettings, getSaves, writeSave, deleteSave, getSeen, markSeen, clearSaves } from './store.js';
import { findScene, bareId } from './format.js';
import { $, debounce, el, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';

let stage = null;
let currentStory = null;
let pendingPersist = null;
let wakeLock = null;
let keyHandler = null;

/** Сколько ручных сохранений показываем в меню. */
const SLOT_IDS = ['1', '2', '3'];

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
  const canResume = !!source && (!!slotSave || !source.ended) && !!findScene(story, source.sceneId);
  const resume = canResume
    ? {
      sceneId: source.sceneId,
      stepIndex: source.stepIndex,
      vars: source.vars || {},
      history: Array.isArray(source.history) ? source.history : [],
    }
    : { sceneId: story.scenes[0].id, stepIndex: 0, history: [] };

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
    history: resume.history || [],
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

/** Что именно запоминаем в сохранении: место, переменные, журнал. */
function positionPayload(story, position, step) {
  return {
    sceneId: position.sceneId,
    sceneIndex: position.sceneIndex,
    stepIndex: position.stepIndex,
    stepId: `${position.sceneId}:${bareId(step?.id || '')}`,
    sceneName: findScene(story, position.sceneId)?.name || '',
    percent: Math.min(1, (flatPosition(story, position.sceneId, position.stepIndex) + 1) / Math.max(1, totalSteps(story))),
    excerpt: (step?.text || '').slice(0, 90),
    vars: position.vars || {},
    history: [...(stage?.history || [])],
    ended: false,
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
    title: 'История реплик',
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

/** Ручные сохранения: три слота, каждый можно записать, открыть и очистить. */
function openSaves(story, opts) {
  const content = (close) => {
    const saves = getSaves(story.id);
    const list = el('div', { class: 'save-slots' });
    const again = () => {
      close();
      setTimeout(() => openSaves(story, opts), 340);
    };

    for (const slot of SLOT_IDS) {
      const entry = saves.slots.find((item) => item.slot === slot);
      const saveHere = () => {
        if (!stage) return;
        writeSave(story.id, slot, positionPayload(story, stage.position, stage.step));
        toast(`Сохранено в слот ${slot}`);
        again();
      };
      list.append(el('div', { class: `save-slot${entry ? ' is-filled' : ''}` },
        el('button', {
          class: 'save-slot-main',
          type: 'button',
          title: entry ? 'Перезаписать слот' : 'Сохранить здесь',
          onclick: saveHere,
        },
        el('span', { class: 'save-slot-title', text: `Слот ${slot}` }),
        el('span', {
          class: 'save-slot-meta',
          text: entry
            ? `${entry.sceneName || 'без названия'} · ${Math.round((entry.percent || 0) * 100)}% · ${slotDate(entry.at)}`
            : 'пусто — нажмите, чтобы сохранить здесь',
        }),
        ),
        entry ? el('button', {
          class: 'pill',
          type: 'button',
          onclick: () => {
            close();
            setTimeout(() => openPlayer(story, { ...opts, slot }), 200);
          },
        }, 'Открыть') : null,
        entry ? el('button', {
          class: 'mini-btn is-danger',
          type: 'button',
          'aria-label': `Удалить слот ${slot}`,
          title: `Удалить слот ${slot}`,
          html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.trash}</svg>`,
          onclick: () => {
            deleteSave(story.id, slot);
            toast(`Слот ${slot} очищен`);
            again();
          },
        }) : null,
      ));
    }

    return el('div', {},
      list,
      el('p', { class: 'field-hint', text: 'Тап по слоту — сохранить текущее место, «Открыть» — вернуться в него. Автосохранение работает отдельно и всегда держит последнюю реплику.' }),
    );
  };

  const filled = getSaves(story.id).slots.length;
  openSheet({
    title: 'Сохранения',
    subtitle: filled
      ? `${filled} ${plural(filled, 'слот', 'слота', 'слотов')} из ${SLOT_IDS.length}`
      : 'Пока пусто — можно сохраниться в любой момент',
    content,
  });
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

  const motionRow = document.createElement('button');
  motionRow.type = 'button';
  motionRow.className = 'sheet-row';
  motionRow.innerHTML = `<span>Меньше анимации<small>без печати текста, дождя и переходов</small></span>`;
  const motionSwitch = el('span', { class: 'switch', role: 'switch', 'aria-checked': String(!!settings.reduceMotion) });
  motionRow.append(motionSwitch);
  motionRow.addEventListener('click', () => {
    const next = !(motionSwitch.getAttribute('aria-checked') === 'true');
    motionSwitch.setAttribute('aria-checked', String(next));
    saveSettings({ reduceMotion: next });
    stage?.applySettings({ reduceMotion: next });
  });

  content.append(speedRow, sizeRow, skipRow, awakeRow, motionRow);

  openSheet({
    title: story.title,
    subtitle: `${Math.round(((stage?.position ? flatPosition(story, stage.position.sceneId, stage.position.stepIndex) + 1 : 1) / Math.max(1, totalSteps(story))) * 100)}% истории · прогресс сохраняется сам`,
    rows: [
      {
        label: 'История реплик',
        icon: ICONS.journal,
        hint: 'всё, что уже прочитано',
        value: stage?.history?.length ? String(stage.history.length) : '',
        onSelect: () => openJournal(story),
      },
      {
        label: 'Сохранения',
        icon: ICONS.save,
        hint: 'три слота для своих мест',
        value: getSaves(story.id).slots.length ? `${getSaves(story.id).slots.length} из ${SLOT_IDS.length}` : '',
        onSelect: () => openSaves(story, opts),
      },
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
