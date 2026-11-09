/* Shared reader settings, available before opening a story. */
import { getSettings, saveSettings } from './store.js';
import { el } from './util.js';
import { openSheet, confirmDialog } from './ui.js';
import { AUDIO_DEFAULTS, playTestTone } from './audio.js';
import { ICONS } from './icons.js';
import { toast } from './ui.js';
import { APP_VERSION } from './version.js';

const DEFAULTS = { ...AUDIO_DEFAULTS, confirmSkip: true, vibration: false, textSpeed: 22, fontSize: 1, spriteScale: 1, dialogueOpacity: .9, instantText: false, skipSeen: false, keepAwake: true, reduceMotion: false, autoDelay: 55 };

const SETTINGS_TABS = [['text', 'Текст'], ['sound', 'Звук'], ['controls', 'Управление']];

function paintRange(input) { const fraction = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)); input.style.setProperty('--range-fill', `${Math.max(0, Math.min(100, fraction * 100))}%`); }

function updateSettings(value) {
  const settings = saveSettings(value);
  document.dispatchEvent(new CustomEvent('vnmy:settings', { detail: settings }));
}

let zoomControlSequence = 0;
function spriteZoomControl() {
  const inputId = `reader-spriteScale-${++zoomControlSequence}`;
  const output = el('output', { htmlFor: inputId, text: `${Math.round(getSettings().spriteScale * 100)}%` });
  const input = el('input', { id: inputId, type: 'range', min: '.5', max: '3', step: '.05', value: String(getSettings().spriteScale), 'aria-label': 'Масштаб персонажей' });
  paintRange(input);
  const apply = value => { updateSettings({ spriteScale: value }); output.textContent = `${Math.round(getSettings().spriteScale * 100)}%`; input.value = String(getSettings().spriteScale); paintRange(input); };
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

let settingsSequence = 0;
export function openSettings(initialTab = 'text') {
  const settingsId = `settings-${++settingsSequence}`;
  let active = initialTab === 'sprites' || SETTINGS_TABS.some(([id]) => id === initialTab) ? initialTab : 'text';
  const content = el('div', { class: 'reader-settings' });
  const tabs = el('div', { class: 'reader-tabs', role: 'tablist', 'aria-label': 'Раздел настроек' });
  const panel = el('div', { class: 'settings-panel', id: `${settingsId}-panel`, role: 'tabpanel' });
  const patch = updateSettings;
  const slider = (label, key, min, max, step, display, read = x => x, write = x => x) => {
    const settings = getSettings();
    const id = `${settingsId}-${key}`;
    const value = settings[key] ?? DEFAULTS[key];
    const output = el('output', { htmlFor: id, text: display(value) });
    const input = el('input', { id, type: 'range', min, max, step, value: String(read(value)), 'aria-label': label });
    paintRange(input);
    input.addEventListener('input', () => {
      paintRange(input);
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
    button.addEventListener('click', async () => {
      const checked = button.getAttribute('aria-checked') !== 'true';
      if (key === 'skipSeen' && checked && getSettings().confirmSkip !== false && !await confirmDialog({ title: 'Пропускать прочитанное?', text: 'Уже прочитанные реплики будут перелистываться автоматически.', confirmText: 'Включить', danger: false })) return;
      button.setAttribute('aria-checked', String(checked));
      button.querySelector('.switch').setAttribute('aria-checked', String(checked));
      patch({ [key]: checked });
    });
    return button;
  };
  function render() {
    tabs.replaceChildren(); panel.replaceChildren();
    for (const [id, label] of SETTINGS_TABS) {
      const tab = el('button', { class: 'reader-tab', type: 'button', role: 'tab', id: `${settingsId}-tab-${id}`, 'aria-selected': String((active === 'sprites' ? 'text' : active) === id), 'aria-controls': panel.id, tabIndex: (active === 'sprites' ? 'text' : active) === id ? 0 : -1, text: label, onclick: () => { active = id; render(); document.getElementById(`${settingsId}-tab-${id}`)?.focus(); } });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = SETTINGS_TABS.findIndex(([id]) => id === active);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        active = SETTINGS_TABS[next][0]; render(); document.getElementById(`${settingsId}-tab-${active}`)?.focus();
      });
      tabs.append(tab);
    }
    panel.setAttribute('aria-labelledby', `${settingsId}-tab-${active === 'sprites' ? 'text' : active}`);
    if (active === 'text') {
      panel.append(el('div', { class: 'settings-preview', style: { '--preview-scale': getSettings().fontSize || 1, '--preview-opacity': getSettings().dialogueOpacity ?? .9 } },
        el('strong', { text: 'Предпросмотр' }), el('p', { text: 'У каждого вечера есть своя история.' })),
      slider('Размер текста', 'fontSize', '.85', '1.35', '.05', value => `${Math.round(value * 100)}%`),
      slider('Скорость текста', 'textSpeed', '6', '55', '1', value => `${Math.round((56 - value) / 50 * 100)}%`, value => 56 - value, value => 56 - value),
      slider('Непрозрачность окна', 'dialogueOpacity', '.35', '1', '.05', value => `${Math.round(value * 100)}%`),
      toggle('Мгновенный текст', 'instantText'),
      el('button', { class: 'sheet-row', type: 'button', text: 'Масштаб персонажей', onclick: () => { close(); openSpriteTuner(); } }));
    } else if (active === 'sound') {
      panel.append(
        slider('Общая громкость', 'masterVolume', '0', '1', '.01', value => `${Math.round(value * 100)}%`),
        slider('Музыка', 'musicVolume', '0', '1', '.01', value => `${Math.round(value * 100)}%`),
        slider('Звуки', 'soundVolume', '0', '1', '.01', value => `${Math.round(value * 100)}%`),
        slider('Голоса', 'voiceVolume', '0', '1', '.01', value => `${Math.round(value * 100)}%`),
        toggle('Звук в фоне', 'backgroundAudio'),
        el('button', { class: 'ghost-btn test-sound', type: 'button', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.play}</svg> Проверить звук`, onclick: async event => {
          const button = event.currentTarget; button.disabled = true;
          try { if (!await playTestTone(getSettings())) toast('Проверка звука недоступна в этом браузере'); } catch { toast('Не удалось включить звук'); } finally { button.disabled = false; }
        } }));
    } else if (active === 'sprites') {
      panel.append(spriteZoomControl());
      if (document.querySelector('#player-host .stage')) panel.append(el('button', { class: 'ghost-btn tune-in-scene', type: 'button', text: 'Настроить на сцене', onclick: () => { close(); openSpriteTuner(); } }));
    } else {
      const gestures = el('div', { class: 'gesture-card' });
      for (const [title, description, icon] of [['Касание', 'Следующая реплика', ICONS.hand], ['Свайп вверх', 'Открыть журнал', ICONS.swipe], ['Долгое нажатие', 'Скрыть интерфейс', ICONS.hold]]) gestures.append(el('div', { class: 'gesture-row' }, el('span', { class: 'gesture-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` }), el('span', {}, el('strong', { text: title }), el('small', { text: description })), el('span', { class: 'chev', text: '›', 'aria-hidden': 'true' })));
      const vibration = toggle('Вибрация', 'vibration');
      if (typeof navigator.vibrate !== 'function') { vibration.disabled = true; vibration.title = 'Устройство не поддерживает вибрацию'; }
      panel.append(gestures, toggle('Пропускать прочитанное', 'skipSeen'), toggle('Подтверждать пропуск', 'confirmSkip'),
        slider('Скорость авточтения', 'autoDelay', '0', '100', '1', value => `${Math.round((100 - value) / 75 * 100)}%`, value => (100 - value) / 75 * 100, value => 100 - value * .75), vibration,
        el('details', { class: 'extra-settings' }, el('summary', { text: 'Дополнительно' }), toggle('Не гасить экран', 'keepAwake'), toggle('Меньше анимации', 'reduceMotion')));
    }
  }
  render();
  content.append(tabs, panel, el('button', { class: 'reset-settings', type: 'button', text: 'Сбросить настройки', onclick: async () => {
    if (await confirmDialog({ title: 'Сбросить настройки?', text: 'Вернуть исходный размер текста, скорость и управление?', confirmText: 'Сбросить', danger: false })) { patch(DEFAULTS); render(); }
  } }), el('p', { class: 'app-version', text: `VNMY ${APP_VERSION}` }));
  const close = openSheet({ title: 'Настройки', content, layout: 'page' });
  return close;
}
