/* VNMY — общие UI-механики: тост, шторка, подтверждение */
import { el, $ } from './util.js';

let modalId = 0;
const modals = [];
function manageModal(node, onClose) {
  const previous = document.activeElement;
  const heading = node.querySelector('h3');
  if (heading) { heading.id = `vnmy-dialog-${++modalId}`; node.setAttribute('aria-labelledby', heading.id); }
  node.tabIndex = -1;
  const item = { node, previous, onClose };
  const update = () => {
    document.body.classList.toggle('no-scroll', modals.length > 0);
    document.querySelectorAll('.screen').forEach(screen => { screen.inert = modals.length > 0; });
    modals.forEach((entry, i) => { entry.node.inert = i !== modals.length - 1; });
    document.dispatchEvent(new CustomEvent('vnmy:modal', { detail: modals.length }));
  };
  const focusables = () => [...node.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')]
    .filter(el => !el.disabled && !el.closest('[hidden]'));
  const onKey = e => {
    if (modals.at(-1) !== item) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); }
    if (e.key === 'Tab') {
      const nodes = focusables();
      const first = nodes[0] || node, last = nodes.at(-1) || node;
      if (!node.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const onFocus = e => {
    if (modals.at(-1) === item && !node.contains(e.target)) (focusables()[0] || node).focus();
  };
  modals.push(item);
  update();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus);
  requestAnimationFrame(() => { if (modals.at(-1) === item) (focusables()[0] || node).focus(); });
  return () => {
    const index = modals.indexOf(item);
    if (index < 0) return;
    modals.splice(index, 1);
    node.inert = true;
    node.style.pointerEvents = 'none';
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus);
    update();
    const target = modals.at(-1)?.node || previous;
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
  };
}

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
  let disposeModal = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    disposeModal();
    backdrop.classList.remove('is-visible');
    sheet.classList.remove('is-visible');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 320);
  };

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
  root.append(backdrop, sheet);
  disposeModal = manageModal(sheet, close);
  requestAnimationFrame(() => {
    if (closed) return;
    backdrop.classList.add('is-visible');
    sheet.classList.add('is-visible');
  });
  return close;
}

export function confirmDialog({ title, text, confirmText = 'Удалить', cancelText = 'Отмена', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    let disposeModal = () => {};
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
      disposeModal();
      backdrop.classList.remove('is-visible');
      box.classList.remove('is-visible');
      setTimeout(() => { backdrop.remove(); box.remove(); }, 320);
          resolve(value);
    };
    backdrop.addEventListener('click', () => finish(false));
    root.append(backdrop, box);
    disposeModal = manageModal(box, () => finish(false));
    requestAnimationFrame(() => {
      backdrop.classList.add('is-visible');
      box.classList.add('is-visible');
    });
  });
}
