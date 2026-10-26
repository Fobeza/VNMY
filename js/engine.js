/* VNMY — движок сцены: рендер фона, спрайтов, реплик, выборов и переходов.
 *
 * const stage = new Stage(host, { story, start: {sceneId, stepIndex}, mode: 'play', onPosition, onExit, onMenu });
 * stage.mount();
 */
import { el, $, clamp } from './util.js';
import {
  findScene, resolveTarget, stateAt, spriteUrl, characterById, resolveUrl, bareId, WEATHERS,
  defaultVars, varByName,
} from './format.js';
import { evalCondition, interpolate, applyOperation } from './expr.js';
import { WeatherLayer } from './weather.js';

const DEFAULTS = { textSpeed: 22, fontSize: 1, skipSeen: false };
/** Сколько реплик держим в журнале: дальше старые просто уходят. */
const HISTORY_LIMIT = 150;

export class Stage {
  constructor(host, opts = {}) {
    this.host = host;
    this.story = opts.story;
    this.mode = opts.mode || 'play';
    this.opts = opts;
    this.settings = { ...DEFAULTS, ...(opts.settings || {}) };
    const startScene = opts.start?.sceneId && findScene(this.story, opts.start.sceneId)
      ? opts.start.sceneId
      : this.story.scenes[0].id;
    this.sceneId = startScene;
    this.index = clamp(opts.start?.stepIndex ?? 0, 0, findScene(this.story, startScene).steps.length - 1);
    this.cast = [];
    this.bgUrl = null;
    this.bgLayer = 0;
    this.ended = false;
    this.typing = null;
    this.awaitingChoices = false;
    this.seen = opts.seen || new Set();
    this.vars = { ...defaultVars(this.story), ...(opts.vars || {}) };
    // журнал реплик: переживает автосейв, чтобы «история» не пропадала
    this.history = Array.isArray(opts.history) ? opts.history.slice(-HISTORY_LIMIT) : [];
    this.mounted = false;
    this.spriteNodes = new Map();
    this._timers = new Set();
    this._pauseToken = 0;
  }

  /* ─────────────────────────── жизненный цикл ─────────────────────────── */

  mount() {
    if (this.mounted) return this;
    const tpl = document.getElementById('tpl-stage');
    const node = tpl.content.firstElementChild.cloneNode(true);
    this.host.append(node);
    this.node = node;
    this.bgA = $('.bg-a', node);
    this.bgB = $('.bg-b', node);
    this.spriteLayer = $('.sprite-layer', node);
    this.dialogue = $('.dialogue', node);
    this.dialogueLayer = $('.dialogue-layer', node);
    this.speakerEl = $('.speaker', node);
    this.textEl = $('.text', node);
    this.hintEl = $('.next-hint', node);
    this.choiceLayer = $('.choice-layer', node);
    this.topTitle = $('.topbar-title', node);
    this.tapLayer = $('.tap-layer', node);
    this.endingLayer = $('.ending-layer', node);
    node.dataset.mode = this.mode;

    this.weather = new WeatherLayer($('.weather-layer', node));
    this.applyMotion();
    this.topTitle.textContent = this.story.title || '';
    this.node.style.setProperty('--accent', this.story.accent || '#e0b072');
    if (this.story.lang) document.documentElement.lang = this.story.lang;
    this.applyFontSize();

    this.tapLayer.addEventListener('click', () => this.handleTap());
    // тап по тексту реплики — самая очевидная цель для игрока: тоже листает
    this.dialogue.addEventListener('click', () => {
      const selection = window.getSelection?.();
      if (selection && String(selection).trim()) return; // не мешаем выделять текст
      if (this.textEl.classList.contains('is-scrollable') && this.textEl.scrollTop > 4) return;
      this.handleTap();
    });
    this.tapLayer.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.handleTap();
      }
    });
    const backBtn = $('.topbar-back', node);
    const menuBtn = $('.topbar-menu', node);
    backBtn.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onExit?.(); });
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onMenu?.(); });

    this.mounted = true;
    this.renderInstance(this.index, { instant: this.opts.instantFirst !== false });
    return this;
  }

  destroy() {
    this.cancelTyping();
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.weather?.destroy();
    this.node?.remove();
    this.mounted = false;
  }

  later(fn, ms) {
    const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  /* ─────────────────────────── настройки ─────────────────────────── */

  applySettings(patch = {}) {
    this.settings = { ...this.settings, ...patch };
    this.applyFontSize();
    this.applyMotion();
  }

  /** «Меньше анимации»: без печати текста, погоды и переходов. */
  applyMotion() {
    const reduced = !!this.settings.reduceMotion;
    this.node?.classList.toggle('is-reduced-motion', reduced);
    this.weather?.setReduced(reduced);
    if (reduced && this.isTyping()) this.finishTyping();
  }

  applyFontSize() {
    if (!this.node) return;
    this.node.style.setProperty('--text-scale', String(this.settings.fontSize || 1));
  }

  /* ─────────────────────────── состояние ─────────────────────────── */

  get scene() { return findScene(this.story, this.sceneId); }
  get step() { return this.scene?.steps[this.index] || null; }

  get position() {
    return {
      sceneId: this.sceneId,
      sceneIndex: this.story.scenes.findIndex((s) => s.id === this.sceneId),
      stepIndex: this.index,
      totalSteps: this.story.scenes.reduce((n, s) => n + s.steps.length, 0),
      ended: this.ended,
      vars: { ...this.vars },
    };
  }

  /** Полный переход к шагу; instant — без анимаций и печати текста. */
  goTo(sceneId, stepIndex, { instant = false, effects = true, force = false } = {}) {
    return this.enter(sceneId, stepIndex, { instant, effects, force });
  }

  /**
   * Вход в шаг: пропускает шаги с ложным условием, применяет изменения
   * переменных и рисует кадр. Единственный путь «перейти куда-то».
   */
  enter(sceneId, stepIndex, { instant = false, effects = true, force = false } = {}) {
    const scene = findScene(this.story, sceneId);
    if (!scene) return false;
    let index = clamp(stepIndex, 0, scene.steps.length - 1);
    // в редакторе первый кадр показываем принудительно: автор должен видеть
    // тот шаг, который выбрал, даже если его условие сейчас ложно
    const forced = force || (this.opts.forceStart && !this._entered);
    this._entered = true;
    let guard = 0;
    while (!forced && index < scene.steps.length
      && scene.steps[index].if
      && !evalCondition(scene.steps[index].if, this.vars)
      && guard++ < 500) {
      index++;
    }
    if (index >= scene.steps.length) return this.leaveScene(scene);

    const sceneChanged = sceneId !== this.sceneId;
    this.sceneId = sceneId;
    this.index = index;
    this.ended = false;
    this.hideEnding();
    if (sceneChanged) this.showChapterCard(scene);
    if (effects) this.applySet(scene.steps[index]);
    this.renderInstance(index, { instant });
    return true;
  }

  /** Сцена закончилась (все шаги позади или скрыты условиями). */
  leaveScene(scene) {
    if (this.opts.limitToScene) {
      this.opts.onSceneEnd?.();
      return false;
    }
    const next = this.story.scenes[this.story.scenes.findIndex((s) => s.id === scene.id) + 1];
    if (next) {
      const firstVisible = next.steps.findIndex((step) => !step.if || evalCondition(step.if, this.vars));
      return this.enter(next.id, firstVisible < 0 ? next.steps.length : firstVisible);
    }
    this.showEnding({ endTitle: 'КОНЕЦ' });
    return false;
  }

  /** Применяет step.set к переменным (один раз, при входе в шаг). */
  applySet(step) {
    if (!step?.set?.length) return;
    for (const op of step.set) {
      const type = varByName(this.story, op.var)?.type || 'number';
      this.vars[op.var] = applyOperation(this.vars[op.var] ?? (type === 'bool' ? false : type === 'text' ? '' : 0), op.op, op.value, type);
    }
    this.opts.onVars?.(this.vars);
  }

  setVar(name, value) {
    this.vars[name] = value;
    this.opts.onVars?.(this.vars);
  }

  resetVars() {
    this.vars = { ...defaultVars(this.story), ...(this.opts.initialVars || {}) };
    this.opts.onVars?.(this.vars);
  }

  /** Добавляет реплику в журнал (без дублей при перерисовке того же шага). */
  noteHistory(step, text) {
    if (this.mode !== 'play' || !step) return;
    const plain = String(text || '').trim();
    if (!plain) return;
    const key = `${this.sceneId}:${bareId(step.id || '')}`;
    const last = this.history[this.history.length - 1];
    if (last && last.key === key && last.text === plain) return;
    const name = step.speaker ? characterById(this.story, step.speaker)?.name || '' : '';
    this.history.push({ key, name, text: plain });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.opts.onHistory?.(this.history);
  }

  /** Какие варианты выбора сейчас доступны (с учётом условий). */
  visibleChoices(step = this.step) {
    if (!step?.choices?.length) return [];
    return step.choices.filter((choice) => !choice.if || evalCondition(choice.if, this.vars));
  }

  renderInstance(index, { instant = false } = {}) {
    const scene = this.scene;
    const step = scene.steps[index];
    if (!step) return;

    const state = stateAt(this.story, scene.id, index);
    let cast = state.cast.map((c) => ({ ...c }));
    if (step.speaker && step.spriteOverride) {
      cast = cast.map((c) => (c.char === step.speaker ? { ...c, sprite: step.spriteOverride } : c));
    }

    this.applyBackground(state.bg, { instant });
    this.applyWeather(state.weather, { instant });
    this.applyCast(cast, { instant, speaker: step.speaker });

    const pause = instant ? 0 : Math.min(4000, Math.max(0, Number(step.pause) || 0));
    if (pause && step.text) {
      const token = ++this._pauseToken;
      this.dialogueLayer.classList.add('is-hidden');
      this.cancelTyping();
      // не оставляем в разметке текст прошлой реплики
      this.textEl.textContent = '';
      this.speakerEl.textContent = '';
      this.later(() => {
        if (token !== this._pauseToken) return;
        this.renderDialogue(step, { instant: false });
      }, pause);
    } else {
      this.renderDialogue(step, { instant });
    }
    this.hideChoices();

    if (!this.mode || this.mode === 'play') {
      if (step.mood) this.playMood(step.mood);
    }

    this.seen.add(`${scene.id}:${bareId(step.id)}`);
    this.opts.onPosition?.(this.position, step);

    // если текста нет — сразу выборы или финал
    if (!step.text) {
      if (step.choices?.length) this.showChoices(step);
      else if (step.end) this.showEnding(step);
    }
  }

  /* ─────────────────────────── фон ─────────────────────────── */

  applyBackground(url, { instant = false } = {}) {
    const node = this.bgLayer % 2 === 0 ? this.bgA : this.bgB;
    const other = this.bgLayer % 2 === 0 ? this.bgB : this.bgA;
    const resolved = resolveUrl(this.story, url);
    if (resolved === this.bgUrl) return;
    this.bgUrl = resolved;

    const show = () => {
      if (!resolved) {
        node.style.backgroundImage = 'none';
        node.style.background = 'radial-gradient(120% 90% at 50% 20%, #1b1f2a, #07080b 70%)';
      } else {
        node.style.background = '';
        node.style.backgroundImage = `url("${resolved.replace(/"/g, '%22')}")`;
      }
      if (instant) {
        node.style.transition = 'none';
        node.classList.add('is-active');
        other.classList.remove('is-active');
        requestAnimationFrame(() => { node.style.transition = ''; });
      } else {
        other.classList.remove('is-active');
        node.classList.add('is-active');
      }
      this.bgLayer++;
    };

    if (instant || !resolved) {
      show();
      return;
    }
    const img = new Image();
    img.onload = show;
    img.onerror = show;
    img.src = resolved;
  }

  applyWeather(kind, { instant = false } = {}) {
    const next = WEATHERS.includes(kind) ? kind : 'none';
    if (instant) {
      this.weather.kind = next; // без анимации — просто пересоздать
      this.weather.setKind(next);
    } else {
      this.weather.setKind(next);
    }
  }

  /* ─────────────────────────── спрайты ─────────────────────────── */

  applyCast(cast, { instant = false, speaker = null } = {}) {
    const layer = this.spriteLayer;
    const wanted = new Map();
    for (const entry of cast) {
      if (!entry || !entry.char || entry.hidden) continue;
      wanted.set(entry.char, entry);
    }

    // удалить лишних
    for (const [charId, node] of this.spriteNodes) {
      if (!wanted.has(charId)) {
        node.classList.add('is-leaving');
        node.classList.remove('is-active');
        this.spriteNodes.delete(charId);
        this.later(() => node.remove(), instant ? 0 : 380);
      }
    }

    let order = 0;
    for (const [charId, entry] of wanted) {
      const char = characterById(this.story, charId);
      let node = this.spriteNodes.get(charId);
      const src = spriteUrl(this.story, charId, entry.sprite);

      if (!node) {
        node = el('div', { class: 'sprite', dataset: { char: charId } },
          el('div', { class: 'sprite-inner' }, el('img', { alt: char?.name || '', draggable: false })),
          el('div', { class: 'sprite-shadow' }),
        );
        node.style.setProperty('--enter-delay', `${instant ? 0 : order * 90}ms`);
        layer.append(node);
        this.spriteNodes.set(charId, node);
        if (instant) node.classList.add('no-anim');
      }

      const img = node.querySelector('img');
      if (img.dataset.src !== src) {
        img.dataset.src = src;
        const swap = () => {
          img.src = src;
          img.classList.remove('is-swapping');
          requestAnimationFrame(() => img.classList.add('is-ready'));
        };
        if (img.getAttribute('src') && !instant) {
          img.classList.add('is-swapping');
          this.later(swap, 180);
        } else {
          swap();
        }
      }

      node.dataset.pos = entry.pos || 'center';
      node.style.setProperty('--scale', String(entry.scale || 1));
      node.style.zIndex = String(entry.pos === 'center' ? 3 : entry.pos === 'left' ? 2 : 1);
      node.classList.toggle('is-dim', !!entry.dim);
      node.classList.toggle('is-speaking', !!speaker && speaker === charId);
      node.classList.toggle('is-idle', !!speaker && speaker !== charId);
      node.classList.add('is-active');
      // перезапуск enter-анимации для новых
      if (!instant && node.dataset.fresh !== 'no') node.dataset.fresh = 'no';
      order++;
    }
  }

  /* ─────────────────────────── реплика ─────────────────────────── */

  renderDialogue(step, { instant = false } = {}) {
    this.cancelTyping();
    const hasText = !!step.text;
    this.dialogueLayer.classList.toggle('is-hidden', !hasText);
    const char = step.speaker ? characterById(this.story, step.speaker) : null;
    this.speakerEl.textContent = char?.name || '';
    this.speakerEl.style.color = char?.color || 'var(--accent)';
    this.speakerEl.classList.toggle('is-empty', !char);
    this.node.classList.toggle('is-narration', !char);

    const fullText = step.text ? interpolate(step.text, this.vars) : '';
    this.noteHistory(step, fullText);
    const segments = parseRich(fullText);
    this.textEl.innerHTML = '';
    const holders = [];
    for (const seg of segments) {
      if (seg.tag === 'br') {
        this.textEl.append(document.createElement('br'));
        continue;
      }
      const holder = seg.tag ? document.createElement(seg.tag) : document.createTextNode('');
      this.textEl.append(holder);
      holders.push({ node: holder, text: seg.text });
    }
    this._holders = holders;

    this.hintEl.classList.remove('is-visible');
    this.dialogue.classList.toggle('is-choice-step', !!step.choices?.length && !hasText);
    this.textEl.style.fontSize = '';
    this.textEl.classList.remove('is-scrollable');

    if (!hasText) return;

    // меряем полный текст до начала печати, чтобы подобрать размер шрифта
    for (const h of holders) h.node.textContent = h.text;
    this.fitText();
    if (!instant) for (const h of holders) h.node.textContent = '';

    if (instant || this.settings.reduceMotion) {
      for (const h of holders) h.node.textContent = h.text;
      this.finishTyping(step);
      return;
    }

    const speed = Math.max(4, Number(this.settings.textSpeed) || 22);
    const total = holders.reduce((n, h) => n + h.text.length, 0);
    const boost = total > 90 ? 0.72 : 1;
    let si = 0;
    let ci = 0;
    let last = performance.now();
    let acc = 0;
    const token = {};
    this.typing = token;
    this.node.classList.add('is-typing');

    const tick = (time) => {
      if (this.typing !== token) return;
      const dt = Math.min(80, time - last);
      last = time;
      acc += dt;
      const stepMs = speed * boost;
      while (acc >= stepMs && si < holders.length) {
        acc -= stepMs;
        const holder = holders[si];
        ci++;
        holder.node.textContent = holder.text.slice(0, ci);
        if (ci >= holder.text.length) { si++; ci = 0; }
      }
      if (si >= holders.length) {
        this.finishTyping(step);
        return;
      }
      this._typingRaf = requestAnimationFrame(tick);
    };
    this._typingRaf = requestAnimationFrame(tick);
  }

  /** Уменьшает шрифт реплики, чтобы текст целиком влез в кадр. */
  fitText() {
    const node = this.textEl;
    if (!node) return;
    node.style.fontSize = '';
    const max = node.clientHeight;
    if (!max) return;
    let size = parseFloat(getComputedStyle(node).fontSize) || 18;
    const min = Math.max(11, size * 0.68);
    let guard = 0;
    while (node.scrollHeight > max + 1 && size > min && guard++ < 16) {
      size -= 1;
      node.style.fontSize = `${size}px`;
    }
    // если даже минимальный размер не помог — разрешаем прокрутку, чтобы текст не терялся
    if (node.scrollHeight > max + 1) node.classList.add('is-scrollable');
  }

  finishTyping(step = this.step) {
    this.cancelTyping(true);
    for (const h of this._holders || []) h.node.textContent = h.text;
    this.node.classList.remove('is-typing');
    this.opts.onTextDone?.(step);
    if (this.awaitingChoices) return;
    if (this.visibleChoices(step).length) {
      this.showChoices(step);
    } else {
      this.hintEl.classList.add('is-visible');
      this.maybeAutoAdvance(step);
    }
  }

  cancelTyping(silent = false) {
    if (this._typingRaf) cancelAnimationFrame(this._typingRaf);
    this._typingRaf = 0;
    this.typing = null;
    if (!silent) this.node?.classList.remove('is-typing');
  }

  isTyping() {
    return !!this.typing;
  }

  /** Автопропуск уже прочитанных реплик при включённой настройке. */
  maybeAutoAdvance(step) {
    if (!this.settings.skipSeen || this.mode !== 'play') return;
    const key = `${this.sceneId}:${bareId(step.id)}`;
    const wasSeen = this.opts.seenBefore?.has(key);
    if (wasSeen) this.later(() => { if (this.isIdle()) this.advance(); }, 90);
  }

  isIdle() {
    return !this.typing && !this.awaitingChoices && !this.ended;
  }

  /* ─────────────────────────── выборы ─────────────────────────── */

  showChoices(step) {
    const choices = this.visibleChoices(step);
    if (!choices.length) return;
    this.awaitingChoices = true;
    this.hintEl.classList.remove('is-visible');
    this.choiceLayer.innerHTML = '';
    this.choiceLayer.classList.add('is-visible');
    choices.forEach((choice, i) => {
      const btn = el('button', {
        class: 'choice',
        type: 'button',
        style: { '--i': String(i) },
      }, el('span', { text: interpolate(choice.text, this.vars) }));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.choose(choice);
      });
      this.choiceLayer.append(btn);
    });
  }

  hideChoices() {
    this.awaitingChoices = false;
    this.choiceLayer.classList.remove('is-visible');
    this.choiceLayer.innerHTML = '';
  }

  choose(choice) {
    this.hideChoices();
    if (this.mode === 'edit') {
      this.opts.onChoice?.(choice);
      return;
    }
    const target = resolveTarget(this.story, choice.goto, this.sceneId);
    if (!target) {
      this.opts.onBrokenLink?.(choice.goto);
      return;
    }
    const picked = String(choice.text || '').trim();
    if (picked) {
      this.history.push({ key: `choice:${this.sceneId}:${this.index}`, name: '', text: `→ ${picked}`, choice: true });
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
      this.opts.onHistory?.(this.history);
    }
    this.goTo(target.sceneId, target.stepIndex);
  }

  /* ─────────────────────────── навигация ─────────────────────────── */

  handleTap() {
    if (this.ended) return;
    this.opts.onTap?.();
    if (this.awaitingChoices) return;
    if (this.isTyping()) {
      this.finishTyping();
      return;
    }
    this.advance();
  }

  advance() {
    const step = this.step;
    if (!step) return;
    if (this.awaitingChoices) return;
    if (this.visibleChoices(step).length) {
      this.showChoices(step);
      return;
    }
    if (step.end) {
      this.showEnding(step);
      return;
    }
    const conditional = this.matchConditionalGoto(step);
    if (conditional) return;
    if (step.goto) {
      const target = resolveTarget(this.story, step.goto, this.sceneId);
      if (target) {
        this.goTo(target.sceneId, target.stepIndex);
        return;
      }
      this.opts.onBrokenLink?.(step.goto);
    }
    if (this.index + 1 < this.scene.steps.length) {
      this.enter(this.sceneId, this.index + 1);
      return;
    }
    this.leaveScene(this.scene);
  }

  /** Первый сработавший условный переход шага. */
  matchConditionalGoto(step) {
    for (const rule of step.gotoIf || []) {
      if (!rule.goto) continue;
      if (!evalCondition(rule.when, this.vars)) continue;
      const target = resolveTarget(this.story, rule.goto, this.sceneId);
      if (target) {
        this.goTo(target.sceneId, target.stepIndex);
        return true;
      }
      this.opts.onBrokenLink?.(rule.goto);
    }
    return false;
  }

  /** Перерисовать текущий шаг без смены позиции (после правок в редакторе). */
  refresh({ instant = true } = {}) {
    if (!this.mounted) return;
    const scene = this.scene;
    if (!scene) return;
    this.index = clamp(this.index, 0, Math.max(0, scene.steps.length - 1));
    this.hideEnding();
    this.renderInstance(this.index, { instant });
    this.opts.onVars?.(this.vars);
  }

  /* ─────────────────────────── эффекты ─────────────────────────── */

  playMood(mood) {
    const node = this.node;
    node.classList.remove('fx-shake', 'fx-zoom', 'fx-blush', 'fx-dim');
    if (mood === 'shake') {
      void node.offsetWidth;
      node.classList.add('fx-shake');
      this.later(() => node.classList.remove('fx-shake'), 520);
    } else if (mood === 'flash') {
      node.classList.add('fx-flash');
      this.later(() => node.classList.remove('fx-flash'), 640);
    } else if (mood === 'blush') {
      node.classList.add('fx-blush');
      this.later(() => node.classList.remove('fx-blush'), 900);
    } else if (mood === 'dim') {
      node.classList.add('fx-dim');
      this.later(() => node.classList.remove('fx-dim'), 900);
    } else if (mood === 'zoom') {
      node.classList.add('fx-zoom');
      this.later(() => node.classList.remove('fx-zoom'), 1200);
    }
  }

  showChapterCard(scene) {
    if (this.mode !== 'play') return;
    const old = $('.chapter-card', this.node);
    old?.remove();
    const card = el('div', { class: 'chapter-card' },
      el('span', { class: 'chapter-line' }),
      el('span', { class: 'chapter-name', text: scene.name }),
      el('span', { class: 'chapter-line' }),
    );
    this.node.append(card);
    this.later(() => card.classList.add('is-out'), 1500);
    this.later(() => card.remove(), 2400);
  }

  /* ─────────────────────────── финал ─────────────────────────── */

  showEnding(step = {}) {
    this.ended = true;
    this.hintEl.classList.remove('is-visible');
    const layer = this.endingLayer;
    layer.innerHTML = '';
    layer.hidden = false;
    layer.append(
      el('div', { class: 'ending-card' },
        el('div', { class: 'ending-kicker', text: 'конец' }),
        el('h2', { class: 'ending-title', text: interpolate(step.endTitle || 'КОНЕЦ', this.vars) }),
        el('div', { class: 'ending-actions' },
          el('button', { class: 'solid-btn', type: 'button', onclick: () => this.restart() }, 'Начать заново'),
          el('button', { class: 'ghost-btn', type: 'button', onclick: () => this.opts.onExit?.() }, 'В библиотеку'),
        ),
      ),
    );
    requestAnimationFrame(() => layer.classList.add('is-visible'));
    this.opts.onEnding?.(step);
  }

  hideEnding() {
    this.endingLayer.hidden = true;
    this.endingLayer.classList.remove('is-visible');
    this.endingLayer.innerHTML = '';
  }

  restart() {
    this.hideEnding();
    this.ended = false;
    this.history = [];
    this.opts.onHistory?.(this.history);
    this.resetVars();
    this.bgUrl = null;
    this.bgLayer = 0;
    this.sceneId = this.story.scenes[0].id;
    this.index = 0;
    this.spriteLayer.innerHTML = '';
    this.spriteNodes.clear();
    this.renderInstance(0, { instant: false });
  }
}

/* ─────────────────────────── разметка реплики ─────────────────────────── */

/** *курсив*, **жирный**, \n — перенос строки. Возвращает сегменты. */
export function parseRich(text) {
  const lines = String(text).split('\n');
  const segments = [];
  lines.forEach((line, i) => {
    if (i > 0) segments.push({ tag: 'br', text: '' });
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) segments.push({ tag: null, text: line.slice(last, m.index) });
      const bold = m[0].startsWith('**');
      segments.push({ tag: bold ? 'strong' : 'em', text: m[0].slice(bold ? 2 : 1, bold ? -2 : -1) });
      last = m.index + m[0].length;
    }
    if (last < line.length) segments.push({ tag: null, text: line.slice(last) });
  });
  return segments.filter((s) => s.tag || s.text.length);
}
