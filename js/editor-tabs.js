/* VNMY — вкладки редактора: «Сцена», «История», «Медиа» */
import {
  POSITIONS, POSITION_LABELS, WEATHERS, WEATHER_LABELS, ACCENTS, newScene, newCharacter,
  newStep, lintStory, characterById, spritePath, resolveUrl, countWords,
  VAR_TYPES, VAR_TYPE_LABELS, newVar, defaultVarValue,
} from './format.js';
import { el, deepClone, plural, uid } from './util.js';
import {
  field, textInput, selectControl, chips, rangeControl, switchControl, segmented, section,
  iconButton, ICONS, imageControl, pickMedia, collectAssets,
} from './editor-ui.js';
import { stepSnippet, promptNewCharacter, targetOptions } from './editor.js';

export const POSITION_SHORT = { left: 'слева', center: 'центр', right: 'справа' };

/* ─────────────────────────── сцена ─────────────────────────── */

export function renderSceneTab(ctx) {
  const scene = ctx.scene;
  const story = ctx.story;
  const wrap = el('div', { class: 'tab-scene' });

  wrap.append(section('Сцена',
    field('Название сцены', textInput({
      value: scene.name,
      onFocus: () => ctx.pushUndo(),
      onInput: (value) => { scene.name = value; ctx.patch(() => {}, { preview: false }); },
    })),
    field('Фон', imageControl({
      story,
      value: scene.bg,
      label: 'Фон сцены',
      onPick: (url) => { ctx.pushUndo(); scene.bg = url || ''; ctx.commit(); },
    }), 'Картинку можно загрузить, выбрать из использованных или указать путь к файлу.'),
    field('Погода', chips({
      options: WEATHERS.map((w) => ({ value: w, label: WEATHER_LABELS[w] })),
      value: scene.weather,
      onChange: (value) => { ctx.pushUndo(); scene.weather = value; ctx.commit({ panel: false }); },
    })),
  ));

  /* состав на сцене */
  const castWrap = el('div', { class: 'cast-list' });
  if (!scene.cast.length) {
    castWrap.append(el('p', { class: 'field-hint', text: 'Сцена без персонажей — только фон и текст.' }));
  }
  scene.cast.forEach((entry, index) => {
    const char = characterById(story, entry.char);
    const spriteKeys = char ? Object.keys(char.sprites || {}) : [];
    const thumb = char ? spritePath(story, entry.char, entry.sprite) : '';
    const row = el('div', { class: 'cast-row' });
    const head = el('div', { class: 'cast-head' },
      el('span', { class: 'cast-thumb' }, thumb ? el('img', { src: resolveUrl(story, thumb), alt: '' }) : null),
      selectControl({
        value: entry.char || '',
        compact: true,
        options: [{ value: '', label: '— персонаж —' }, ...story.characters.map((c) => ({ value: c.id, label: c.name }))],
        onChange: (value) => {
          ctx.pushUndo();
          entry.char = value || null;
          const next = characterById(story, value);
          entry.sprite = next ? Object.keys(next.sprites || {})[0] || 'neutral' : 'neutral';
          ctx.commit();
        },
      }),
      selectControl({
        value: entry.sprite || 'neutral',
        compact: true,
        options: spriteKeys.length ? spriteKeys.map((k) => ({ value: k, label: k })) : [{ value: 'neutral', label: 'нет спрайтов' }],
        onChange: (value) => { ctx.pushUndo(); entry.sprite = value; ctx.commit({ panel: false }); },
      }),
      iconButton(ICONS.trash, {
        label: 'Убрать персонажа',
        danger: true,
        onclick: () => { ctx.pushUndo(); scene.cast.splice(index, 1); ctx.commit(); },
      }),
    );
    const controls = el('div', { class: 'cast-controls' },
      segmented({
        options: POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
        value: entry.pos || 'center',
        onChange: (value) => { ctx.pushUndo(); entry.pos = value; ctx.commit({ panel: false, instant: true }); },
      }),
      rangeControl({
        label: 'Размер',
        min: 0.6, max: 1.5, step: 0.02, value: entry.scale || 1,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (value) => { entry.scale = value; ctx.patch(() => {}, { preview: true }); },
      }),
      switchControl({
        label: 'Затемнить',
        hint: 'персонаж на втором плане',
        checked: !!entry.dim,
        onChange: (value) => { ctx.pushUndo(); entry.dim = value; ctx.commit({ panel: false }); },
      }),
    );
    row.append(head, controls);
    castWrap.append(row);
  });

  wrap.append(section('Кто на сцене',
    castWrap,
    el('div', { class: 'inline-row' },
      el('button', {
        type: 'button',
        class: 'ghost-btn',
        onclick: () => {
          if (!story.characters.length) {
            promptNewCharacter(ctx, (char) => {
              ctx.pushUndo();
              scene.cast.push({ char: char.id, sprite: Object.keys(char.sprites || {})[0] || 'neutral', pos: 'center', scale: 1, dim: false });
              ctx.commit();
            });
            return;
          }
          ctx.pushUndo();
          const char = story.characters[0];
          scene.cast.push({ char: char.id, sprite: Object.keys(char.sprites || {})[0] || 'neutral', pos: scene.cast.length % 2 ? 'right' : 'left', scale: 1, dim: false });
          ctx.commit();
        },
      }, '+ Добавить на сцену'),
      el('button', {
        type: 'button',
        class: 'ghost-btn',
        onclick: () => promptNewCharacter(ctx, () => ctx.commit()),
      }, '+ Персонаж'),
    ),
  ));

  /* список сцен */
  const list = el('div', { class: 'scene-list' });
  story.scenes.forEach((s, i) => {
    list.append(el('div', { class: `scene-row${s.id === scene.id ? ' is-active' : ''}` },
      el('button', {
        type: 'button',
        class: 'scene-row-main',
        onclick: () => ctx.selectScene(s.id),
      },
      el('span', { class: 'scene-row-thumb', style: { backgroundImage: s.bg ? `url("${resolveUrl(story, s.bg).replace(/"/g, '%22')}")` : '' } }),
      el('span', { class: 'scene-row-text' },
        el('span', { class: 'scene-row-name', text: s.name }),
        el('small', { text: `${s.steps.length} ${plural(s.steps.length, 'шаг', 'шага', 'шагов')}${s.cast.length ? ` · ${s.cast.length} перс.` : ''}` }),
      )),
      el('span', { class: 'scene-row-actions' },
        iconButton(ICONS.up, {
          label: 'Выше',
          onclick: () => {
            if (i === 0) return;
            ctx.pushUndo();
            [story.scenes[i - 1], story.scenes[i]] = [story.scenes[i], story.scenes[i - 1]];
            ctx.commit();
          },
        }),
        iconButton(ICONS.down, {
          label: 'Ниже',
          onclick: () => {
            if (i === story.scenes.length - 1) return;
            ctx.pushUndo();
            [story.scenes[i + 1], story.scenes[i]] = [story.scenes[i], story.scenes[i + 1]];
            ctx.commit();
          },
        }),
        iconButton(ICONS.trash, {
          label: 'Удалить сцену',
          danger: true,
          onclick: async () => {
            if (story.scenes.length === 1) { ctx.toast('Нужна хотя бы одна сцена'); return; }
            const ok = await ctx.confirmDialog({
              title: 'Удалить сцену?',
              text: `«${s.name}» и все её реплики исчезнут. Переходы в эту сцену сломаются.`,
              confirmText: 'Удалить',
            });
            if (!ok) return;
            ctx.pushUndo();
            story.scenes.splice(i, 1);
            ctx.commit();
            ctx.selectScene(story.scenes[Math.max(0, i - 1)].id, { panel: false });
          },
        }),
      ),
    ));
  });

  wrap.append(section('Все сцены',
    list,
    el('button', {
      type: 'button',
      class: 'ghost-btn full',
      onclick: () => {
        ctx.pushUndo();
        const s = newScene({ name: `Сцена ${story.scenes.length + 1}` });
        story.scenes.push(s);
        ctx.commit();
        ctx.selectScene(s.id);
      },
    }, '+ Новая сцена'),
    el('p', { class: 'field-hint', text: 'Сцены листаются сверху вниз, если в конце сцены не задан переход.' }),
  ));

  return wrap;
}

/* ─────────────────────────── история ─────────────────────────── */

export function renderStoryTab(ctx) {
  const story = ctx.story;
  const wrap = el('div', { class: 'tab-story' });
  const { steps } = countWords(story);

  wrap.append(section('Общее',
    field('Название', textInput({
      value: story.title,
      onFocus: () => ctx.pushUndo(),
      onInput: (value) => { story.title = value; ctx.updateTitle(value); ctx.patch(() => {}, { preview: false }); },
    })),
    field('Автор', textInput({
      value: story.author || '',
      placeholder: 'ваше имя',
      onFocus: () => ctx.pushUndo(),
      onInput: (value) => { story.author = value; ctx.patch(() => {}, { preview: false }); },
    })),
    field('Описание', textInput({
      value: story.description || '',
      placeholder: 'одна строка для библиотеки',
      onFocus: () => ctx.pushUndo(),
      onInput: (value) => { story.description = value; ctx.patch(() => {}, { preview: false }); },
    })),
    field('Язык текста', selectControl({
      value: story.lang || 'ru',
      options: [
        { value: 'ru', label: 'Русский' },
        { value: 'en', label: 'English' },
        { value: 'de', label: 'Deutsch' },
        { value: 'uk', label: 'Українська' },
        { value: 'es', label: 'Español' },
        { value: 'fr', label: 'Français' },
        { value: 'ja', label: '日本語' },
        { value: 'zh', label: '中文' },
      ],
      onChange: (value) => {
        ctx.pushUndo();
        story.lang = value;
        document.documentElement.lang = value;
        ctx.commit({ panel: false, preview: false });
      },
    }), 'Влияет на переносы, кавычки и озвучку экранным диктором.'),
    field('Обложка', imageControl({
      story,
      value: story.cover,
      ratio: '9 / 14',
      label: 'Обложка истории',
      onPick: (url) => { ctx.pushUndo(); story.cover = url || ''; ctx.commit(); },
    })),
    field('Акцентный цвет', chips({
      options: ACCENTS.map((c) => ({ value: c, label: '', color: c, title: c })),
      value: story.accent,
      onChange: (value) => {
        ctx.pushUndo();
        story.accent = value;
        document.documentElement.style.setProperty('--accent', value);
        ctx.commit({ panel: false, preview: false });
      },
    }), 'Цвет имён, выборов и кнопок.'),
  ));

  /* переменные */
  const varsList = el('div', { class: 'var-list' });
  if (!story.vars.length) {
    varsList.append(el('p', { class: 'field-hint', text: 'Пока нет переменных. Они нужны для условий: «показывать, если…», «перейти, если…», «изменить при входе в шаг».' }));
  }
  story.vars.forEach((v, index) => {
    varsList.append(el('div', { class: 'var-row' },
      textInput({
        value: v.name,
        placeholder: 'имя',
        onFocus: () => ctx.pushUndo(),
        onBlur: (value, input) => {
          const next = String(value).trim().replace(/[^\p{L}\p{N}_]/gu, '_');
          if (!next || next === v.name) return;
          if (story.vars.some((other) => other !== v && other.name === next)) {
            ctx.toast('Такая переменная уже есть');
            input.value = v.name;
            return;
          }
          ctx.pushUndo();
          renameVarInStory(story, v.name, next);
          ctx.commit();
        },
      }),
      selectControl({
        value: v.type,
        compact: true,
        options: VAR_TYPES.map((t) => ({ value: t, label: VAR_TYPE_LABELS[t] })),
        onChange: (value) => { ctx.pushUndo(); v.type = value; v.initial = defaultVarValue({ type: value, initial: v.initial }); ctx.commit(); },
      }),
      v.type === 'bool'
        ? switchControl({
          label: '',
          checked: !!defaultVarValue(v),
          onChange: (checked) => { ctx.pushUndo(); v.initial = checked; ctx.commit(); },
        })
        : textInput({
          value: String(v.initial ?? ''),
          placeholder: 'старт',
          onFocus: () => ctx.pushUndo(),
          onInput: (value) => { v.initial = value; ctx.patch(() => {}, { preview: false }); },
        }),
      iconButton(ICONS.trash, {
        label: 'Удалить переменную',
        danger: true,
        onclick: async () => {
          const used = countVarUsages(story, v.name);
          if (used) {
            const ok = await ctx.confirmDialog({
              title: `Удалить «${v.name}»?`,
              text: `Переменная используется в ${used} ${plural(used, 'месте', 'местах', 'местах')}. Условия с ней станут ложными.`,
              confirmText: 'Удалить',
            });
            if (!ok) return;
          }
          ctx.pushUndo();
          story.vars.splice(index, 1);
          ctx.commit();
        },
      }),
    ));
  });

  wrap.append(section('Переменные',
    varsList,
    el('button', {
      type: 'button',
      class: 'ghost-btn full',
      onclick: () => {
        ctx.pushUndo();
        let n = 1;
        while (story.vars.some((v) => v.name === `переменная${n}`)) n++;
        story.vars.push(newVar({ name: `переменная${n}` }));
        ctx.commit();
      },
    }, '+ Переменная'),
    el('p', { class: 'field-hint', text: 'В тексте пишите {имя} — подставится значение. В условиях: sympathy >= 2, met_anya, not ending_seen. Сравнения: == != > >= < <=, объединение: && (and), || (or), отрицание: ! (not).' }),
  ));

  /* персонажи */
  const chars = el('div', { class: 'char-list' });
  story.characters.forEach((char, index) => {
    const spriteEntries = Object.entries(char.sprites || {});
    const firstSprite = spriteEntries[0]?.[1] || '';
    const spritesBox = el('div', { class: 'sprite-list' });

    spriteEntries.forEach(([key, url]) => {
      spritesBox.append(el('div', { class: 'sprite-row' },
        el('button', {
          type: 'button',
          class: 'sprite-thumb',
          title: 'Заменить картинку',
          style: { backgroundImage: `url("${resolveUrl(story, url).replace(/"/g, '%22')}")` },
          onclick: () => pickMedia({
            story,
            title: `Спрайт · ${char.name}`,
            current: url,
            onPick: (next) => {
              if (!next) return;
              ctx.pushUndo();
              char.sprites[key] = next;
              ctx.commit();
            },
          }),
        }),
        textInput({
          value: key,
          placeholder: 'эмоция',
          onBlur: (value) => {
            const next = value.trim();
            if (!next || next === key) return;
            ctx.pushUndo();
            renameSpriteKey(story, char.id, key, next);
            ctx.commit();
          },
        }),
        iconButton(ICONS.trash, {
          label: 'Удалить спрайт',
          danger: true,
          onclick: () => {
            ctx.pushUndo();
            delete char.sprites[key];
            ctx.commit();
          },
        }),
      ));
    });

    chars.append(el('div', { class: 'char-card' },
      el('div', { class: 'char-head' },
        el('span', { class: 'char-avatar', style: firstSprite ? { backgroundImage: `url("${resolveUrl(story, firstSprite).replace(/"/g, '%22')}")` } : {} }),
        el('div', { class: 'char-fields' },
          textInput({
            value: char.name,
            placeholder: 'Имя',
            onFocus: () => ctx.pushUndo(),
            onInput: (value) => { char.name = value; ctx.patch(() => {}, { preview: true }); },
          }),
          el('span', { class: 'color-swatch-row' },
            el('input', {
              type: 'color',
              class: 'color-input',
              value: char.color || '#e0b072',
              onInput: (e) => { char.color = e.target.value; ctx.patch(() => {}, { preview: true }); },
              onFocus: () => ctx.pushUndo(),
            }),
            el('span', { class: 'field-hint', text: 'цвет имени' }),
          ),
        ),
        iconButton(ICONS.trash, {
          label: 'Удалить персонажа',
          danger: true,
          onclick: async () => {
            const ok = await ctx.confirmDialog({
              title: `Удалить «${char.name}»?`,
              text: 'Персонаж исчезнет из сцен и реплик.',
              confirmText: 'Удалить',
            });
            if (!ok) return;
            ctx.pushUndo();
            story.characters.splice(index, 1);
            for (const scene of story.scenes) {
              scene.cast = scene.cast.filter((c) => c.char !== char.id);
              for (const step of scene.steps) {
                if (step.speaker === char.id) step.speaker = null;
                if (step.cast) step.cast = step.cast.filter((c) => c.char !== char.id);
              }
            }
            ctx.commit();
          },
        }),
      ),
      spritesBox,
      el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => {
          let n = 1;
          while (char.sprites[`эмоция${n}`]) n++;
          pickMedia({
            story,
            title: `Новый спрайт · ${char.name}`,
            onPick: (url) => {
              if (!url) return;
              ctx.pushUndo();
              char.sprites[`эмоция${n}`] = url;
              ctx.commit();
            },
          });
        },
      }, '+ спрайт'),
    ));
  });

  wrap.append(section('Персонажи',
    chars,
    el('button', {
      type: 'button',
      class: 'ghost-btn full',
      onclick: () => promptNewCharacter(ctx, () => ctx.commit()),
    }, '+ Новый персонаж'),
    el('p', { class: 'field-hint', text: 'Спрайт — картинка персонажа на прозрачном фоне. Названия эмоций потом выбираются в реплике.' }),
  ));

  /* проверка */
  const issues = lintStory(story);
  const checkBox = el('div', { class: 'lint-list' });
  if (!issues.length) {
    checkBox.append(el('p', { class: 'lint-ok', text: '✓ Ссылки в порядке. Можно играть.' }));
  } else {
    for (const issue of issues.slice(0, 12)) {
      checkBox.append(el('button', {
        type: 'button',
        class: `lint-item is-${issue.level}`,
        onclick: () => {
          const target = issue.stepId
            ? { sceneId: issue.sceneId, stepIndex: findStepIndexSafe(story, issue.sceneId, issue.stepId) }
            : { sceneId: issue.sceneId, stepIndex: 0 };
          ctx.switchTab('step');
          ctx.selectStep(target.sceneId, target.stepIndex);
        },
      }, el('span', { class: 'lint-dot' }), issue.text));
    }
    if (issues.length > 12) checkBox.append(el('p', { class: 'field-hint', text: `и ещё ${issues.length - 12}…` }));
  }
  wrap.append(section('Проверка', checkBox));

  wrap.append(section('История целиком',
    el('div', { class: 'stats-row' },
      stat(`${story.scenes.length}`, 'сцен'),
      stat(`${steps}`, 'шагов'),
      stat(`${countWords(story).words}`, 'слов'),
      stat(`${story.characters.length}`, 'перс.'),
    ),
    el('div', { class: 'inline-row' },
      el('button', { type: 'button', class: 'ghost-btn', onclick: () => ctx.exportStory() }, 'Экспорт JSON'),
      el('button', { type: 'button', class: 'ghost-btn', onclick: () => ctx.duplicate() }, 'Дублировать'),
    ),
    el('button', {
      type: 'button',
      class: 'ghost-btn full danger-outline',
      onclick: () => ctx.removeStory(),
    }, 'Удалить историю'),
    el('p', { class: 'field-hint', text: 'Экспорт даёт story.json. Положите его в stories/<имя>/ и добавьте имя в stories/index.json — история появится в библиотеке на любом устройстве.' }),
  ));

  return wrap;
}

function renameVarInStory(story, from, to) {
  const replaceWord = (text) => String(text || '').replace(
    new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeReg(from)}(?![\\p{L}\\p{N}_])`, 'gu'),
    (m, prefix) => prefix + to,
  );
  const replacePlaceholder = (text) => String(text || '').replace(new RegExp(`\\{${escapeReg(from)}\\}`, 'gu'), `{${to}}`);
  for (const scene of story.scenes) {
    for (const step of scene.steps) {
      if (step.if) step.if = replaceWord(step.if);
      if (step.text) step.text = replacePlaceholder(step.text);
      if (step.endTitle) step.endTitle = replacePlaceholder(step.endTitle);
      for (const op of step.set || []) if (op.var === from) op.var = to;
      for (const rule of step.gotoIf || []) if (rule.when) rule.when = replaceWord(rule.when);
      for (const choice of step.choices || []) {
        if (choice.if) choice.if = replaceWord(choice.if);
        if (choice.text) choice.text = replacePlaceholder(choice.text);
      }
    }
  }
}

function escapeReg(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countVarUsages(story, name) {
  let count = 0;
  const uses = (text) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeReg(name)}(?![\\p{L}\\p{N}_])`, 'u').test(String(text || ''));
  const usesPlaceholder = (text) => String(text || '').includes(`{${name}}`);
  for (const scene of story.scenes) {
    for (const step of scene.steps) {
      if (step.if && uses(step.if)) count++;
      if (step.text && usesPlaceholder(step.text)) count++;
      if (step.endTitle && usesPlaceholder(step.endTitle)) count++;
      for (const op of step.set || []) if (op.var === name) count++;
      for (const rule of step.gotoIf || []) if (rule.when && uses(rule.when)) count++;
      for (const choice of step.choices || []) {
        if (choice.if && uses(choice.if)) count++;
        if (choice.text && usesPlaceholder(choice.text)) count++;
      }
    }
  }
  return count;
}

function stat(value, label) {
  return el('div', { class: 'stat' }, el('strong', { text: value }), el('span', { text: label }));
}

function findStepIndexSafe(story, sceneId, stepId) {
  const scene = story.scenes.find((s) => s.id === sceneId);
  if (!scene) return 0;
  const idx = scene.steps.findIndex((s) => s.id === stepId);
  return idx < 0 ? 0 : idx;
}

function renameSpriteKey(story, charId, from, to) {
  const char = characterById(story, charId);
  if (!char || char.sprites[to]) return;
  char.sprites[to] = char.sprites[from];
  delete char.sprites[from];
  for (const scene of story.scenes) {
    for (const entry of scene.cast) if (entry.char === charId && entry.sprite === from) entry.sprite = to;
    for (const step of scene.steps) {
      if (step.cast) for (const entry of step.cast) if (entry.char === charId && entry.sprite === from) entry.sprite = to;
      if (step.speaker === charId && step.spriteOverride === from) step.spriteOverride = to;
    }
  }
}

/* ─────────────────────────── медиа ─────────────────────────── */

export function renderMediaTab(ctx) {
  const story = ctx.story;
  const wrap = el('div', { class: 'tab-media' });
  const assets = collectAssets(story);
  const uploadInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  uploadInput.addEventListener('change', async () => {
    const files = [...(uploadInput.files || [])];
    uploadInput.value = '';
    if (!files.length) return;
    ctx.pushUndo();
    for (const file of files) {
      try {
        const { compressImage } = await import('./util.js');
        const { url } = await compressImage(file, { maxSide: 1600, quality: 0.85 });
        story.media.push({ id: uid('m'), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), url, kind: 'image' });
      } catch (err) {
        console.error(err);
        ctx.toast(`Не удалось загрузить ${file.name}`);
      }
    }
    ctx.commit();
    ctx.toast('Картинки добавлены в историю');
  });

  const grid = el('div', { class: 'media-grid media-grid-wide' });
  for (const asset of assets) {
    const mediaItem = story.media.find((m) => m.url === asset.url);
    grid.append(el('div', { class: 'media-card' },
      el('div', { class: 'media-card-thumb', style: { backgroundImage: `url("${resolveUrl(story, asset.url).replace(/"/g, '%22')}")` } }),
      el('div', { class: 'media-card-body' },
        el('span', { class: 'media-card-name', text: mediaItem?.name || asset.url.split('/').pop() || 'картинка' }),
        el('small', { text: asset.usages.slice(0, 2).join(' · ') || 'не используется' }),
      ),
      mediaItem ? iconButton(ICONS.trash, {
        label: 'Убрать из медиатеки',
        danger: true,
        onclick: () => {
          ctx.pushUndo();
          story.media = story.media.filter((m) => m.id !== mediaItem.id);
          ctx.commit();
        },
      }) : el('span', { class: 'media-card-tag', text: 'путь' }),
    ));
  }
  if (!assets.length) grid.append(el('p', { class: 'field-hint', text: 'Картинок пока нет. Загрузите фон или спрайт.' }));

  wrap.append(section('Медиатека',
    el('div', { class: 'inline-row' },
      el('button', { type: 'button', class: 'ghost-btn', onclick: () => uploadInput.click() }, '+ Загрузить картинки'),
      uploadInput,
    ),
    grid,
    el('p', { class: 'field-hint', text: 'Загруженные картинки хранятся внутри истории (data URL) и попадают в экспорт. Для больших проектов удобнее держать файлы в папке stories/<имя>/assets и указывать путь.' }),
  ));

  return wrap;
}
