/* VNMY — элементы управления редактора и медиатека */
import { el, compressImage, uid } from './util.js';
import { resolveUrl } from './format.js';
import { compile as compileExpression } from './expr.js';

/* ─────────────────────────── базовые контролы ─────────────────────────── */

export function field(label, control, hint) {
  return el('div', { class: 'field' },
    label ? el('label', { text: label }) : null,
    control,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  );
}

export function textInput({ value = '', placeholder = '', onInput, onBlur, onFocus, type = 'text' } = {}) {
  const input = el('input', { class: 'input', type, value, placeholder });
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  if (onBlur) input.addEventListener('blur', () => onBlur(input.value, input));
  // onFocus используется для снимка undo перед правкой — без него шаг не отменяется
  if (onFocus) input.addEventListener('focus', () => onFocus(input));
  return input;
}

export function textArea({ value = '', placeholder = '', rows = 3, onInput, onFocus } = {}) {
  const area = el('textarea', { class: 'input textarea', rows, placeholder, value });
  const autoresize = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.max(64, area.scrollHeight)}px`;
  };
  area.addEventListener('input', () => {
    autoresize();
    onInput?.(area.value);
  });
  if (onFocus) area.addEventListener('focus', () => onFocus(area));
  requestAnimationFrame(autoresize);
  return area;
}

/**
 * Поле условия с живой проверкой синтаксиса и кнопками-переменными.
 * Пустое значение = «без условия».
 */
export function conditionInput({ story, value = '', placeholder = 'например: sympathy >= 2', onChange, onFocus, compact = false } = {}) {
  const status = el('span', { class: 'cond-status' });
  const input = el('input', { class: 'input cond-input', type: 'text', value, placeholder });
  const vars = story?.vars || [];
  const wrap = el('div', { class: `cond-field${compact ? ' is-compact' : ''}` });

  const validate = (text) => {
    const src = String(text || '').trim();
    if (!src) {
      status.className = 'cond-status';
      status.textContent = '';
      return true;
    }
    const { error, deps } = compileExpression(src);
    if (error) {
      status.className = 'cond-status is-error';
      status.textContent = `ошибка: ${error.message}`;
      return false;
    }
    const unknown = deps.filter((d) => !vars.some((v) => v.name === d));
    if (unknown.length) {
      status.className = 'cond-status is-error';
      status.textContent = `не объявлено: ${unknown.join(', ')}`;
      return false;
    }
    status.className = 'cond-status is-ok';
    status.textContent = 'условие в порядке';
    return true;
  };

  input.addEventListener('input', () => {
    const ok = validate(input.value);
    input.classList.toggle('has-error', !ok);
    onChange?.(input.value);
  });
  if (onFocus) input.addEventListener('focus', () => onFocus(input));

  wrap.append(input);
  if (vars.length) {
    const chipsRow = el('div', { class: 'cond-vars' });
    for (const v of vars) {
      chipsRow.append(el('button', {
        type: 'button',
        class: 'cond-var',
        title: `${v.name} (${v.type})`,
        onclick: () => {
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          input.value = input.value.slice(0, start) + v.name + input.value.slice(end);
          input.focus();
          input.selectionStart = input.selectionEnd = start + v.name.length;
          validate(input.value);
          onChange?.(input.value);
        },
      }, v.name));
    }
    wrap.append(chipsRow);
  }
  wrap.append(status);
  validate(value);
  input.classList.toggle('has-error', status.classList.contains('is-error'));
  return wrap;
}

export function selectControl({ value = '', options = [], onChange, compact = false } = {}) {
  const select = el('select', { class: `input select${compact ? ' is-compact' : ''}` });
  for (const opt of options) {
    if (opt.group) {
      const group = el('optgroup', { label: opt.label });
      for (const child of opt.group) group.append(el('option', { value: child.value, text: child.label }));
      select.append(group);
    } else {
      select.append(el('option', { value: opt.value, text: opt.label }));
    }
  }
  select.value = value;
  if (select.value !== value && options.length) {
    // значение не найдено — оставляем пустым, чтобы не показывать ложь
    select.value = '';
  }
  select.addEventListener('change', () => onChange?.(select.value));
  return select;
}

export function chips({ options, value, onChange, multi = false, values = [] } = {}) {
  const wrap = el('div', { class: 'chips' });
  for (const opt of options) {
    const active = multi ? values.includes(opt.value) : opt.value === value;
    const btn = el('button', {
      type: 'button',
      class: `chip${active ? ' is-active' : ''}${opt.color ? ' chip-color' : ''}`,
      title: opt.title || opt.label,
      style: opt.color ? { background: opt.color } : {},
      onclick: () => {
        if (multi) {
          const next = values.includes(opt.value) ? values.filter((v) => v !== opt.value) : [...values, opt.value];
          btn.classList.toggle('is-active', next.includes(opt.value));
          onChange?.(next);
        } else {
          for (const sibling of wrap.children) sibling.classList.remove('is-active');
          btn.classList.add('is-active');
          onChange?.(opt.value);
        }
      },
    }, opt.label);
    wrap.append(btn);
  }
  return wrap;
}

export function rangeControl({ label, min = 0, max = 1, step = 0.05, value = 1, onInput, format } = {}) {
  const note = el('span', { class: 'range-note', text: format ? format(value) : String(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    note.textContent = format ? format(v) : String(v);
    onInput?.(v);
  });
  return el('div', { class: 'field field-compact' },
    label ? el('label', { text: label }) : null,
    el('div', { class: 'range-row' }, input, note),
  );
}

export function switchControl({ label, hint, checked = false, onChange } = {}) {
  const sw = el('span', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked) });
  const row = el('button', { type: 'button', class: 'switch-row' },
    el('span', { class: 'switch-text' }, el('span', { text: label }), hint ? el('small', { text: hint }) : null),
    sw,
  );
  row.addEventListener('click', () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    onChange?.(next);
  });
  return row;
}

export function segmented({ options, value, onChange } = {}) {
  const wrap = el('div', { class: 'segmented' });
  for (const opt of options) {
    wrap.append(el('button', {
      type: 'button',
      class: `segment${opt.value === value ? ' is-active' : ''}`,
      onclick: (e) => {
        for (const sibling of wrap.children) sibling.classList.remove('is-active');
        e.currentTarget.classList.add('is-active');
        onChange?.(opt.value);
      },
    }, opt.label));
  }
  return wrap;
}

export function section(title, ...children) {
  return el('section', { class: 'ed-section' },
    el('h4', { class: 'ed-section-title', text: title }),
    ...children.filter(Boolean),
  );
}

export function iconButton(svgPath, { label, onclick, active = false, danger = false } = {}) {
  const btn = el('button', {
    type: 'button',
    class: `mini-btn${active ? ' is-active' : ''}${danger ? ' is-danger' : ''}`,
    'aria-label': label,
    title: label,
    onclick,
  });
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svgPath}</svg>`;
  return btn;
}

export const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a1 1 0 0 0-1 1v9"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
};

/* ─────────────────────────── медиатека ─────────────────────────── */

export function collectAssets(story) {
  const map = new Map();
  const add = (url, usage, kind = 'image') => {
    if (!url) return;
    const key = url;
    if (!map.has(key)) map.set(key, { url, kind, usages: [] });
    if (usage) map.get(key).usages.push(usage);
  };
  add(story.cover, 'обложка');
  for (const m of story.media || []) add(m.url, `медиатека: ${m.name}`);
  story.scenes.forEach((scene, si) => {
    add(scene.bg, `фон сцены «${scene.name}»`);
    scene.steps.forEach((step) => {
      if (step.bg) add(step.bg, `смена фона, сцена «${scene.name}» #${si + 1}`);
    });
  });
  for (const char of story.characters) {
    for (const [key, url] of Object.entries(char.sprites || {})) add(url, `спрайт ${char.name} · ${key}`);
  }
  return [...map.values()];
}

async function handleUpload(file, story) {
  const { url } = await compressImage(file, { maxSide: 1600, quality: 0.85 });
  const item = { id: uid('m'), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), url, kind: 'image' };
  story.media = story.media || [];
  story.media.push(item);
  return item;
}

/**
 * Шторка выбора картинки: медиатека истории, уже использованные пути,
 * загрузка файла и ручной путь (например assets/bg.webp).
 */
export function pickMedia({ story, title = 'Картинка', current = '', onPick, onUpload } = {}) {
  import('./ui.js').then(({ openSheet, toast }) => {
    const assets = collectAssets(story);
    const uploaded = (story.media || []);
    const body = el('div', { class: 'media-sheet' });

    const grid = el('div', { class: 'media-grid' });
    const seen = new Set();
    const pushTile = (url, label, isCurrent = false) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      const tile = el('button', {
        type: 'button',
        class: `media-tile${isCurrent ? ' is-current' : ''}`,
        onclick: () => { close(); onPick?.(url, label); },
      },
      el('span', { class: 'media-thumb', style: { backgroundImage: `url("${resolveUrl(story, url).replace(/"/g, '%22')}")` } }),
      el('span', { class: 'media-name', text: label || url.split('/').pop() }));
      grid.append(tile);
    };
    if (uploaded.length) {
      body.append(el('h5', { class: 'media-title', text: 'Загружено в историю' }));
      for (const item of uploaded) pushTile(item.url, item.name, item.url === current);
      body.append(grid);
    }
    const others = assets.filter((a) => !uploaded.some((u) => u.url === a.url));
    if (others.length) {
      body.append(el('h5', { class: 'media-title', text: 'Используется в истории' }));
      const g2 = el('div', { class: 'media-grid' });
      for (const a of others) {
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        g2.append(el('button', {
          type: 'button',
          class: `media-tile${a.url === current ? ' is-current' : ''}`,
          onclick: () => { close(); onPick?.(a.url, a.usages[0] || ''); },
        },
        el('span', { class: 'media-thumb', style: { backgroundImage: `url("${resolveUrl(story, a.url).replace(/"/g, '%22')}")` } }),
        el('span', { class: 'media-name', text: a.usages[0] || 'картинка' }),
        ));
      }
      body.append(g2);
    }
    if (!seen.size) body.append(el('p', { class: 'field-hint', text: 'Пока пусто — загрузите картинку или впишите путь к файлу.' }));

    const uploadInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = '';
      if (!file) return;
      try {
        const item = await handleUpload(file, story);
        onUpload?.(item);
        close();
        onPick?.(item.url, item.name);
        toast('Картинка добавлена в историю');
      } catch (err) {
        console.error(err);
        toast('Не удалось загрузить картинку');
      }
    });

    const pathInput = textInput({ placeholder: 'assets/bg.webp или https://…' });
    const pathRow = el('div', { class: 'inline-row' }, pathInput,
      el('button', {
        type: 'button',
        class: 'ghost-btn',
        onclick: () => {
          const value = pathInput.value.trim();
          if (!value) return;
          close();
          onPick?.(value, value.split('/').pop());
        },
      }, 'Взять'));

    body.append(
      el('div', { class: 'media-actions' },
        el('button', { type: 'button', class: 'ghost-btn', onclick: () => uploadInput.click() }, '+ Загрузить с устройства'),
        uploadInput,
      ),
      el('h5', { class: 'media-title', text: 'Путь к файлу' }),
      pathRow,
      el('p', { class: 'field-hint', text: 'Путь считается от папки истории: stories/<имя>/… — так ассеты живут рядом со story.json.' }),
      current ? el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => { close(); onPick?.('', 'убрать'); },
      }, 'Убрать картинку') : null,
    );

    const close = openSheet({ title, subtitle: 'Выберите картинку для этой истории', content: body });
  });
}

/** Кнопка-превью картинки с подписью; открывает pickMedia */
export function imageControl({ story, value, label, ratio = '9 / 16', onPick } = {}) {
  const preview = el('div', {
    class: 'image-control-preview',
    style: {
      backgroundImage: value ? `url("${resolveUrl(story, value).replace(/"/g, '%22')}")` : '',
      aspectRatio: ratio,
    },
  }, value ? null : el('span', { class: 'image-control-empty', text: 'нет картинки' }));
  return el('button', {
    type: 'button',
    class: 'image-control',
    onclick: () => pickMedia({ story, title: label || 'Выберите картинку', current: value, onPick }),
  }, preview, el('span', { class: 'image-control-label', text: value ? 'Заменить' : 'Выбрать' }));
}
