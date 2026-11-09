/* Shared reader settings, available before opening a story. */
import { getSettings, saveSettings } from './store.js';
import { el } from './util.js';
import { openSheet, confirmDialog } from './ui.js';
import { APP_VERSION } from './version.js';

const DEFAULTS = { textSpeed: 22, fontSize: 1, spriteScale: 1, dialogueOpacity: .9, instantText: false, skipSeen: false, keepAwake: true, reduceMotion: false, autoDelay: 55 };

const SETTINGS_TABS = [['text', 'Текст'], ['sprites', 'Сцена'], ['controls', 'Управление']];

function updateSettings(value) {
  const settings = saveSettings(value);
  document.dispatchEvent(new CustomEvent('vnmy:settings', { detail: settings }));
}

function spriteZoomControl() {
  const output = el('output', { htmlFor: 'reader-spriteScale', text: `${Math.round(getSettings().spriteScale * 100)}%` });
  const input = el('input', { id: 'reader-spriteScale', type: 'range', min: '.5', max: '3', step: '.05', value: String(getSettings().spriteScale), 'aria-label': 'Масштаб персонажей' });
  const apply = value => { updateSettings({ spriteScale: value }); output.textContent = `${Math.round(getSettings().spriteScale * 100)}%`; input.value = String(getSettings().spriteScale); };
  input.addEventListener('input', () => apply(Number(input.value)));
  return el('div', { class: 'sprite-zoom-control' },
    el('div', { class: 'setting-range' }, el('div', { class: 'setting-label' }, el('label', { htmlFor: input.id, text: 'Масштаб персонажей' }), output), input),
    el('div', { class: 'zoom-scale-labels' }, el('span', { text: '50%' }), el('button', { type: 'button', class: 'text-btn', text: 'Сбросить до 100%', onclick: () => apply(1) }), el('span', { text: '300%' })),
    el('p', { class: 'field-hint', text: 'Для всех историй. Увеличиваются только персонажи; фон и текст сохраняют размер.' }));
}

export function openSpriteTuner() {
  const stage = document.querySelector('#player-host .stage');
  if (!stage) return openSettings('sprites');
  stage.classList.add('is-adjusting-sprites');
  return openSheet({ title: 'Масштаб персонажей', layout: 'tune', content: spriteZoomControl(), onClose: () => stage.classList.remove('is-adjusting-sprites') });
}

export function openSettings(initialTab = 'text') {
  let active = SETTINGS_TABS.some(([id]) => id === initialTab) ? initialTab : 'text';
  const content = el('div', { class: 'reader-settings' });
  const tabs = el('div', { class: 'reader-tabs', role: 'tablist', 'aria-label': 'Раздел настроек' });
  const panel = el('div', { class: 'settings-panel', id: 'reader-settings-panel', role: 'tabpanel' });
  const patch = updateSettings;
  const slider = (label, key, min, max, step, display, read = x => x, write = x => x) => {
    const settings = getSettings();
    const id = `reader-${key}`;
    const value = settings[key] ?? DEFAULTS[key];
    const output = el('output', { htmlFor: id, text: display(value) });
    const input = el('input', { id, type: 'range', min, max, step, value: String(read(value)), 'aria-label': label });
    input.addEventListener('input', () => {
      const value = write(Number(input.value));
      patch({ [key]: value }); output.textContent = display(value);
      if (key === 'fontSize') panel.querySelector('.settings-preview')?.style.setProperty('--preview-scale', value);
      if (key === 'dialogueOpacity') panel.querySelector('.settings-preview')?.style.setProperty('--preview-opacity', value);
    });
    return el('div', { class: 'setting-range' }, el('div', { class: 'setting-label' }, el('label', { htmlFor: id, text: label }), output), input);
  };
  const toggle = (label, key, hint) => {
    const button = el('button', { type: 'button', class: 'sheet-row', role: 'switch', 'aria-label': label, 'aria-checked': String(!!getSettings()[key]) },
      el('span', {}, el('span', { text: label }), hint ? el('small', { text: hint }) : null),
      el('span', { class: 'switch', 'aria-hidden': 'true', 'aria-checked': String(!!getSettings()[key]) }));
    button.addEventListener('click', () => {
      const checked = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(checked));
      button.querySelector('.switch').setAttribute('aria-checked', String(checked));
      patch({ [key]: checked });
    });
    return button;
  };
  function render() {
    tabs.replaceChildren(); panel.replaceChildren();
    for (const [id, label] of SETTINGS_TABS) {
      const tab = el('button', { class: 'reader-tab', type: 'button', role: 'tab', id: `settings-tab-${id}`, 'aria-selected': String(active === id), 'aria-controls': panel.id, tabIndex: active === id ? 0 : -1, text: label, onclick: () => { active = id; render(); document.getElementById(`settings-tab-${id}`)?.focus(); } });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = SETTINGS_TABS.findIndex(([id]) => id === active);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        active = SETTINGS_TABS[next][0]; render(); document.getElementById(`settings-tab-${active}`)?.focus();
      });
      tabs.append(tab);
    }
    panel.setAttribute('aria-labelledby', `settings-tab-${active}`);
    if (active === 'text') {
      panel.append(el('div', { class: 'settings-preview', style: { '--preview-scale': getSettings().fontSize || 1, '--preview-opacity': getSettings().dialogueOpacity ?? .9 } },
        el('strong', { text: 'Предпросмотр' }), el('p', { text: 'У каждого вечера есть своя история.' })),
      slider('Размер текста', 'fontSize', '.85', '1.35', '.05', value => `${Math.round(value * 100)}%`),
      slider('Скорость текста', 'textSpeed', '6', '55', '1', value => `${Math.round((56 - value) / 50 * 100)}%`, value => 56 - value, value => 56 - value),
      slider('Непрозрачность окна', 'dialogueOpacity', '.35', '1', '.05', value => `${Math.round(value * 100)}%`),
      toggle('Мгновенный текст', 'instantText'));
    } else if (active === 'sprites') {
      panel.append(spriteZoomControl());
      if (document.querySelector('#player-host .stage')) panel.append(el('button', { class: 'ghost-btn tune-in-scene', type: 'button', text: 'Настроить на сцене', onclick: () => { close(); openSpriteTuner(); } }));
    } else {
      panel.append(el('p', { class: 'field-hint', text: 'Коснитесь сцены или реплики, чтобы продолжить. Скрыть интерфейс можно через меню игры; следующее касание вернёт его.' }),
      toggle('Пропускать прочитанное', 'skipSeen', 'Автоматически листать только знакомые реплики'),
      slider('Пауза авточтения', 'autoDelay', '25', '100', '5', value => `${value} мс / символ`),
      toggle('Не гасить экран', 'keepAwake'), toggle('Меньше анимации', 'reduceMotion'));
    }
  }
  render();
  content.append(tabs, panel, el('button', { class: 'reset-settings', type: 'button', text: 'Сбросить настройки', onclick: async () => {
    if (await confirmDialog({ title: 'Сбросить настройки?', text: 'Вернуть исходный размер текста, скорость и управление?', confirmText: 'Сбросить', danger: false })) { patch(DEFAULTS); render(); }
  } }), el('p', { class: 'app-version', text: `VNMY ${APP_VERSION}` }));
  const close = openSheet({ title: 'Настройки', content, layout: 'page' });
  return close;
}
