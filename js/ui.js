/* VNMY — общие UI-механики: тост, шторка, подтверждение */
import { el, $ } from './util.js';

let toastTimer = 0;

export function toast(message, ms = 2400) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), ms);
}

/** Нижняя шторка. content — элемент или функция(close). */
export function openSheet({ title, subtitle, content, rows } = {}) {
  const root = $('#overlay-root');
  const backdrop = el('div', { class: 'overlay-backdrop' });
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'sheet-handle' }),
    title ? el('h3', { text: title }) : null,
    subtitle ? el('p', { class: 'sheet-sub', text: subtitle }) : null,
  );
  const close = () => {
    backdrop.classList.remove('is-visible');
    sheet.classList.remove('is-visible');
    document.body.classList.remove('no-scroll');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 320);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  if (rows?.length) {
    const list = el('div', { class: 'sheet-list' });
    for (const row of rows) {
      if (!row) continue;
      const main = el('span', { class: 'sheet-row-main' },
        row.icon ? el('span', { class: 'sheet-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${row.icon}</svg>` }) : null,
        el('span', {}, el('span', { class: 'sheet-label', text: row.label }), row.hint ? el('small', { text: row.hint }) : null),
      );
      list.append(el('button', {
        class: `sheet-row${row.danger ? ' danger' : ''}`,
        type: 'button',
        onclick: () => { if (row.keepOpen !== true) close(); row.onSelect?.(); },
      },
      main,
      row.value ? el('span', { class: 'value', text: row.value }) : el('span', { class: 'chev', text: '›' }),
      ));
    }
    sheet.append(list);
  }

  if (content) {
    const node = typeof content === 'function' ? content(close) : content;
    sheet.append(node);
  }
  sheet.append(el('button', { class: 'ghost-btn', type: 'button', style: { width: '100%', marginTop: '14px' }, onclick: close }, 'Закрыть'));

  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  root.append(backdrop, sheet);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => {
    backdrop.classList.add('is-visible');
    sheet.classList.add('is-visible');
  });
  return close;
}

export function confirmDialog({ title, text, confirmText = 'Удалить', cancelText = 'Отмена', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const root = $('#overlay-root');
    const backdrop = el('div', { class: 'overlay-backdrop' });
    const box = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', style: { paddingBottom: 'calc(28px + var(--safe-b))' } },
      el('div', { class: 'sheet-handle' }),
      el('h3', { text: title }),
      text ? el('p', { class: 'sheet-sub', text, style: { marginTop: '8px', marginBottom: '20px' } }) : null,
      el('div', { style: { display: 'flex', gap: '10px', marginTop: '6px' } },
        el('button', { class: 'ghost-btn', type: 'button', style: { flex: '1' }, onclick: () => finish(false) }, cancelText),
        el('button', {
          class: 'ghost-btn',
          type: 'button',
          style: { flex: '1', background: danger ? 'rgba(200, 70, 66, .16)' : 'color-mix(in srgb, var(--accent) 18%, transparent)', borderColor: danger ? 'rgba(220, 90, 86, .4)' : 'var(--line)' },
          onclick: () => finish(true),
        }, confirmText),
      ),
    );
    const finish = (value) => {
      if (done) return;
      done = true;
      backdrop.classList.remove('is-visible');
      box.classList.remove('is-visible');
      setTimeout(() => { backdrop.remove(); box.remove(); }, 320);
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    backdrop.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKey);
    root.append(backdrop, box);
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => {
      backdrop.classList.add('is-visible');
      box.classList.add('is-visible');
    });
  });
}

/** Поле ввода внутри шторки/панели */
export function textField({ label, value = '', placeholder = '', multiline = false, rows = 3, onInput, onBlur, maxLength } = {}) {
  const input = multiline ? el('textarea', { rows, placeholder, value }) : el('input', { type: 'text', placeholder, value });
  if (maxLength) input.maxLength = maxLength;
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  if (onBlur) input.addEventListener('blur', () => onBlur(input.value));
  return el('div', { class: 'field' }, label ? el('label', { text: label }) : null, input);
}
