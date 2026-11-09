/* VNMY — движок сцены: рендер фона, спрайтов, реплик, выборов и переходов.
 *
 * const stage = new Stage(host, { story, start: {sceneId, stepIndex}, mode: 'play', onPosition, onExit, onMenu });
 * stage.mount();
 */
import { el, $, clamp, clampSpriteScale } from './util.js';
import {
  findScene, resolveTarget, stateAt, spriteUrl, characterById, resolveUrl, bareId, WEATHERS,
} from './format.js';
import { evalCondition, interpolate } from './expr.js';
import { NarrativeState, HISTORY_LIMIT } from './session.js';
import { installReadingGestures } from './gestures.js';
import { StoryAudio } from './audio.js';
import { WeatherLayer } from './weather.js';

const DEFAULTS = { textSpeed: 22, fontSize: 1, skipSeen: false };
/** Через сколько шагов молчания персонаж на сцене считается «фоном». */
const STALE_BEATS = 7;

export class Stage extends NarrativeState {
  constructor(host, opts = {}) {
    super(opts);
    this.host = host;
    this.settings = { ...DEFAULTS, ...(opts.settings || {}) };
    this.audio = new StoryAudio(this.story, this.settings);
    this.bgUrl = null;
    this.bgLayer = 0;
    this.typing = null;
    this.awaitingChoices = false;
    this.asking = false;
    this.mounted = false;
    this.spriteNodes = new Map();
    this._timers = new Set();
    this._pauseToken = 0;
    this._renderToken = 0;
    this.paused = false;
    /* Кто участвует в разговоре: номер «такта» (перехода на шаг), когда
     * персонаж последний раз говорил и когда появился на сцене. */
    this._beat = 0;
    this._spokeAt = new Map();
    this._enteredAt = new Map();
    /* Был ли текущий шаг прочитан до этого входа в него. */
    this._stepWasSeen = false;
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
    this.askLayer = $('.ask-layer', node);
    this.askLabel = $('.ask-label', node);
    this.askInput = $('.ask-input', node);
    this.liveEl = $('.reader-live', node);
    $('.ask-submit', node)?.addEventListener('click', () => this.submitAsk());
    this.askInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submitAsk(); }
    });
    node.dataset.mode = this.mode;

    this.weather = new WeatherLayer($('.weather-layer', node));
    this.applyMotion();
    this.topTitle.textContent = this.story.title || '';
    $('.quick-auto', node)?.addEventListener('click', () => {
      this.autoReading = !this.autoReading;
      $('.quick-auto', node).setAttribute('aria-pressed', String(this.autoReading));
      if (this.autoReading && this.isIdle()) this.maybeAutoAdvance(this.step);
    });
    $('.quick-menu', node)?.addEventListener('click', () => this.opts.onMenu?.());
    $('.quick-journal', node)?.addEventListener('click', () => this.opts.onJournal?.());
    $('.quick-save', node)?.addEventListener('click', () => this.opts.onSaves?.());
    $('.quick-hide', node)?.addEventListener('click', () => node.classList.toggle('ui-hidden'));
    // После нажатия пальцем или мышью фокус не остаётся на кнопке: иначе
    // Пробел и Enter снова нажмут её вместо перехода к следующей реплике.
    // Фокус, пришедший с клавиатуры (Tab), сохраняется.
    node.addEventListener('click', (e) => {
      const button = e.target.closest?.('.quick-actions button, .topbar button');
      if (button && e.detail > 0) button.blur();
    });
    this.node.style.setProperty('--accent', '#8d9af2');
    if (this.story.lang) document.documentElement.lang = this.story.lang;
    this.applyFontSize();

    this.tapLayer.addEventListener('click', () => this.handleTap());
    // тап по тексту реплики — самая очевидная цель для игрока: тоже листает
    this.dialogue.addEventListener('click', () => {
      const selection = window.getSelection?.();
      if (selection && String(selection).trim()) return; // не мешаем выделять текст
      // прокрутка длинной реплики пальцем не порождает click, поэтому
      // касание листает даже после прокрутки вниз
      this.handleTap();
    });
    this.tapLayer.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        this.handleTap();
      }
    });
    const backBtn = $('.topbar-back', node);
    backBtn.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onExit?.(); });

    this.mounted = true;
    this.disposeGestures = installReadingGestures(this);
    if (this.opts.resuming) {
      this._entered = true;
      this.renderInstance(this.index, { instant: true, replay: true });
    } else {
      this.enter(this.sceneId, this.index, { instant: this.opts.instantFirst !== false });
    }
    return this;
  }

  destroy() {
    this.invalidateRender();
    this.cancelTyping();
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.weather?.destroy();
    this.audio.destroy();
    this.disposeGestures?.();
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
    this.audio.applySettings(this.settings);
  }

  /** «Меньше анимации»: без печати текста, погоды и переходов. */
  applyMotion() {
    const reduced = !!this.settings.reduceMotion;
    this.node?.classList.toggle('is-reduced-motion', reduced);
    this.weather?.setReduced(reduced);
    if ((reduced || this.settings.instantText) && this.isTyping()) this.finishTyping();
  }

  applyFontSize() {
    if (!this.node) return;
    this.node.style.setProperty('--sprite-scale', String(clampSpriteScale(this.settings.spriteScale)));
    this.node.style.setProperty('--text-scale', String(this.settings.fontSize || 1));
    this.node.style.setProperty('--dialogue-opacity', String(this.settings.dialogueOpacity ?? 0.9));
    if (this._holders?.length) this.fitText();
  }

  /* ─────────────────────────── состояние ─────────────────────────── */

  /** Полный переход к шагу; instant — без анимаций и печати текста. */
  goTo(sceneId, stepIndex, { instant = false, effects = true } = {}) {
    return this.enter(sceneId, stepIndex, { instant, effects });
  }

  /**
   * Вход в шаг: пропускает шаги с ложным условием, применяет изменения
   * переменных и рисует кадр. Единственный путь «перейти куда-то».
   */
  enter(sceneId, stepIndex, { instant = false, effects = true } = {}) {
    const scene = findScene(this.story, sceneId);
    if (!scene) return false;
    let index = clamp(stepIndex, 0, scene.steps.length - 1);
    while (index < scene.steps.length
      && scene.steps[index].if
      && !evalCondition(scene.steps[index].if, this.vars)) {
      index++;
    }
    if (index >= scene.steps.length) return this.leaveScene(scene);

    // первый вход (новая игра, «Начать заново») тоже показывает карточку сцены
    const sceneChanged = sceneId !== this.sceneId || !this._entered;
    this._entered = true;
    this.invalidateRender();
    this.moveTo(sceneId, index);
    this._beat++;
    if (this.step.speaker) this._spokeAt.set(this.step.speaker, this._beat);
    this.ended = false;
    this.hideEnding();
    if (sceneChanged) this.showChapterCard(scene);
    if (effects) this.applySet(scene.steps[index]);
    this.renderInstance(index, { instant });
    return true;
  }

  /** Сцена закончилась (все шаги позади или скрыты условиями). */
  leaveScene(scene) {
    const next = this.story.scenes[this.story.scenes.findIndex((s) => s.id === scene.id) + 1];
    if (next) {
      const firstVisible = next.steps.findIndex((step) => !step.if || evalCondition(step.if, this.vars));
      return this.enter(next.id, firstVisible < 0 ? next.steps.length : firstVisible);
    }
    this.showEnding({ endTitle: 'КОНЕЦ' });
    return false;
  }

  /** Добавляет реплику в журнал (без дублей при перерисовке того же шага). */
  noteHistory(step, text) {
    if (this.mode !== 'play' || !step) return;
    const plain = String(text || '').trim();
    if (!plain) return;
    const key = `${this.sceneId}:${bareId(step.id || '')}`;
    const last = this.history[this.history.length - 1];
    if (last && last.key === key && last.text === plain) return;
    const name = step.speaker ? interpolate(characterById(this.story, step.speaker)?.name || '', this.vars) : '';
    this.history.push({ key, name, text: plain });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.opts.onHistory?.(this.history);
  }

  /** Какие варианты выбора сейчас доступны (с учётом условий). */
  visibleChoices(step = this.step) {
    if (!step?.choices?.length) return [];
    return step.choices.filter((choice) => !choice.if || evalCondition(choice.if, this.vars));
  }

  /** replay — перерисовка того же шага (после меню, загрузки): без эффектов. */
  renderInstance(index, { instant = false, replay = false } = {}) {
    const scene = this.scene;
    const step = scene.steps[index];
    if (!step) return;

    const state = this.visual;
    let cast = state.cast.map((c) => ({ ...c }));
    if (step.speaker && step.spriteOverride) {
      cast = cast.map((c) => (c.char === step.speaker ? { ...c, sprite: step.spriteOverride } : c));
    }

    this.hideChoices();
    this.applyBackground(state.bg, { instant });
    this.applyWeather(state.weather, { instant });
    this.applyCast(cast, { instant, speaker: step.speaker });
    this.audio.render(state, step, replay);

    const renderToken = this._renderToken;
    const pause = instant ? 0 : Math.min(4000, Math.max(0, Number(step.pause) || 0));
    if (pause && step.text) {
      const token = ++this._pauseToken;
      this.waitingPause = true;
      this.dialogue.classList.add('is-hidden');
      this.cancelTyping();
      // не оставляем в разметке текст прошлой реплики
      this.textEl.textContent = '';
      this.speakerEl.textContent = '';
      this.later(() => {
        if (token !== this._pauseToken || renderToken !== this._renderToken) return;
        this.waitingPause = false;
        this.renderDialogue(step, { instant: false });
      }, pause);
    } else {
      this.renderDialogue(step, { instant });
    }

    // эффект играет при входе в шаг, а не при перерисовке после меню
    if (!replay && step.mood) this.playMood(step.mood);

    const key = `${scene.id}:${bareId(step.id)}`;
    // «прочитано» — до этого входа в шаг, включая текущую сессию;
    // перерисовка после меню не делает шаг прочитанным
    if (!replay) this._stepWasSeen = this.seen.has(key);
    this.seen.add(key);
    try {
      this.opts.onPosition?.(this.position, step);
    } catch (err) {
      // ошибка сохранения (например, переполнение хранилища) не должна
      // останавливать историю: выборы и финал показываются в любом случае
      console.error('[vnmy] onPosition', err);
    }

    // если текста нет — сразу доступные выборы или финал; выборы имеют приоритет
    if (!step.text || step.end) {
      if (this.visibleChoices(step).length) this.showChoices(step);
      else if (step.end) this.showEnding(step);
      // шаг без реплики (только фон, состав, переменные) ждёт касания —
      // авточтение и пропуск прочитанного идут дальше сами
      else if (!this.asking) this.maybeAutoAdvance(step);
    }
  }

  /* ─────────────────────────── фон ─────────────────────────── */

  applyBackground(url, { instant = false } = {}) {
    const node = this.bgLayer % 2 === 0 ? this.bgA : this.bgB;
    const other = this.bgLayer % 2 === 0 ? this.bgB : this.bgA;
    const resolved = resolveUrl(this.story, url);
    if (resolved === this.bgUrl) return;
    this.bgUrl = resolved;

    const token = this._renderToken;
    const show = () => {
      if (!this.mounted || token !== this._renderToken || resolved !== this.bgUrl) return;
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
      this._paintedBgUrl = resolved;
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
    this.weather.setKind(next);
  }

  /* ─────────────────────────── спрайты ─────────────────────────── */

  applyCast(cast, { instant = false, speaker = null } = {}) {
    const layer = this.spriteLayer;
    const wanted = new Map();
    const occupied = new Set();
    for (const entry of cast) {
      if (!entry || !entry.char || entry.hidden || wanted.has(entry.char)) continue;
      if (!spriteUrl(this.story, entry.char, entry.sprite)) continue;
      if (wanted.size === 3) break;
      const pos = ['left', 'center', 'right'].includes(entry.pos) ? entry.pos : 'center';
      const available = [pos, 'left', 'center', 'right'].find(p => !occupied.has(p));
      occupied.add(available);
      wanted.set(entry.char, { ...entry, pos: available });
    }

    const replacing = [...wanted.keys()].some(id => !this.spriteNodes.has(id));
    // Never overlap departing actors with newcomers beyond the three slots.
    layer.querySelectorAll('.sprite.is-leaving').forEach(node => node.remove());
    // удалить лишних
    for (const [charId, node] of this.spriteNodes) {
      if (!wanted.has(charId)) {
        node.classList.add('is-leaving');
        node.classList.remove('is-active', 'is-speaking', 'is-listening', 'is-idle', 'is-background');
        node.style.zIndex = '0';
        this.spriteNodes.delete(charId);
        this._enteredAt.delete(charId);
        this._spokeAt.delete(charId);
        if (replacing || instant) node.remove();
        else this.later(() => node.remove(), 480);
      }
    }

    const focus = this.conversationFocus(wanted, speaker);
    const created = [];
    for (const [charId, entry] of wanted) {
      const char = characterById(this.story, charId);
      let node = this.spriteNodes.get(charId);
      const src = spriteUrl(this.story, charId, entry.sprite);

      if (!node) {
        node = el('div', { class: 'sprite', dataset: { char: charId } },
          el('div', { class: 'sprite-inner' }, el('img', { alt: char?.name || '', draggable: false })),
          el('div', { class: 'sprite-shadow' }),
        );
        layer.append(node);
        this.spriteNodes.set(charId, node);
        if (!this._enteredAt.has(charId)) this._enteredAt.set(charId, this._beat);
        if (instant) node.classList.add('no-anim');
        created.push(node);
      }

      const img = node.querySelector('img');
      if (img.dataset.requested !== src) {
        img.dataset.requested = src;
        const sequence = img._swapSequence = (img._swapSequence || 0) + 1;
        const swap = () => {
          // A new dialogue beat must not cancel an image that is still loading.
          // A different pose, removed actor or destroyed stage must cancel it.
          if (!this.mounted || this.spriteNodes.get(charId) !== node ||
              img._swapSequence !== sequence || img.dataset.requested !== src) return;
          img.src = src;
          img.dataset.src = src;
        };
        if (!src) {
          swap();
        } else {
          // Keep the painted sprite visible until the next pose is decoded.
          const next = new Image();
          next.onload = () => {
            if (typeof next.decode === 'function') next.decode().then(swap, swap);
            else swap();
          };
          next.onerror = () => {
            if (img._swapSequence === sequence && img.dataset.requested === src) {
              img.dataset.requested = img.dataset.src || '';
            }
          };
          next.src = src;
        }
      }

      const role = focus.get(charId);
      node.dataset.pos = entry.pos || 'center';
      node.dataset.role = role;
      node.style.setProperty('--scale', String(entry.scale || 1));
      // говорящий всегда поверх соседей, остальные — центр над краями
      node.style.zIndex = String(role === 'speaking' ? 5 : role === 'listening' ? 4 : entry.pos === 'center' ? 3 : entry.pos === 'left' ? 2 : 1);
      node.classList.toggle('is-dim', !!entry.dim);
      node.classList.toggle('is-speaking', role === 'speaking');
      node.classList.toggle('is-listening', role === 'listening');
      node.classList.toggle('is-idle', role === 'idle' || role === 'background');
      node.classList.toggle('is-background', role === 'background');
    }

    if (created.length && !instant) {
      // новый спрайт должен сначала отрисоваться прозрачным — иначе
      // переход opacity не запустится и персонаж просто «выскочит»
      void layer.offsetWidth;
    }
    for (const node of this.spriteNodes.values()) node.classList.add('is-active');
    if (instant && created.length) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const node of created) node.classList.remove('no-anim');
      }));
    }
  }

  /**
   * Роль каждого персонажа на сцене в текущей реплике:
   *  speaking   — говорит сейчас;
   *  listening  — собеседник: говорит герой без спрайта (или рассказчик
   *               сразу после его реплики), а этот персонаж говорил последним;
   *  idle       — участвует в разговоре, но сейчас молчит;
   *  background — давно молчит (STALE_BEATS шагов) — стоит фоном;
   *  neutral    — реплика рассказчика, персонаж в разговоре.
   */
  conversationFocus(wanted, speaker) {
    const roles = new Map();
    const onStage = (id) => wanted.has(id);
    const lastActive = (id) => Math.max(this._spokeAt.get(id) ?? -Infinity, this._enteredAt.get(id) ?? this._beat);
    let listener = null;
    if (!speaker || !onStage(speaker)) {
      let best = -Infinity;
      for (const id of wanted.keys()) {
        const at = this._spokeAt.get(id);
        if (at != null && at > best) { best = at; listener = id; }
      }
      // рассказчик: собеседник подсвечен, только если он говорил совсем недавно
      if (!speaker && (best < this._beat - 2)) listener = null;
    }
    for (const id of wanted.keys()) {
      const stale = this._beat - lastActive(id) >= STALE_BEATS;
      if (speaker && id === speaker) roles.set(id, 'speaking');
      else if (id === listener) roles.set(id, 'listening');
      else if (stale) roles.set(id, 'background');
      else roles.set(id, speaker || listener ? 'idle' : 'neutral');
    }
    return roles;
  }

  /* ─────────────────────────── реплика ─────────────────────────── */

  renderDialogue(step, { instant = false } = {}) {
    this.cancelTyping();
    this.renderAsk(step);
    // у финального шага текст показывается на самом экране финала
    const hasText = !!step.text && !step.end;
    this.dialogue.classList.toggle('is-hidden', !hasText);
    const char = step.speaker ? characterById(this.story, step.speaker) : null;
    this.speakerEl.textContent = char ? interpolate(char.name || '', this.vars) : '';
    this.speakerEl.style.color = char?.color || 'var(--accent)';
    this.speakerEl.classList.toggle('is-empty', !char);
    this.node.classList.toggle('is-narration', !char);

    const fullText = step.text ? interpolate(step.text, this.vars) : '';
    // пока открыт вопрос ask, подстановка ещё пустая: в журнал реплика
    // попадёт после ответа, один раз
    if (!this.asking) this.noteHistory(step, fullText);
    // экранный диктор читает реплику целиком, а не по букве во время печати
    if (this.liveEl) {
      const spoken = hasText && !this.asking ? fullText.replace(/\*\*(.+?)\*\*|\*(.+?)\*/g, '$1$2') : '';
      this.liveEl.textContent = spoken && char ? `${this.speakerEl.textContent}: ${spoken}` : spoken;
    }
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

    if (instant || this.settings.reduceMotion || this.settings.instantText) {
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

  /** Keep the reader's chosen size; long lines scroll instead of shrinking. */
  fitText() {
    const node = this.textEl;
    if (!node) return;
    node.style.fontSize = '';
    node.classList.toggle('is-scrollable', node.scrollHeight > node.clientHeight + 1);
  }

  invalidateRender() {
    this._renderToken++;
    this._pauseToken++;
    this.waitingPause = false;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    this.bgUrl = this._paintedBgUrl ?? null;
    for (const img of this.spriteLayer?.querySelectorAll('img') || []) {
      img.dataset.src = img.getAttribute('src') || '';
    }
    this.node?.querySelectorAll('.sprite.is-leaving, .chapter-card').forEach(n => n.remove());
    this.node?.classList.remove('fx-shake', 'fx-flash', 'fx-zoom', 'fx-blush', 'fx-dim');
  }

  setPaused(value) {
    this.paused = value;
    this.audio.setPaused(value);
    if (value) { this.invalidateRender(); this.cancelTyping(); }
    else if (this.mounted && !this.ended) this.renderInstance(this.index, { instant: true, replay: true });
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
    if (this.paused || this.mode !== 'play') return;
    if (this._stepWasSeen && this.settings.skipSeen) {
      this.later(() => { if (this.settings.skipSeen && this.isIdle()) this.advance(); }, 90);
    } else if (this.autoReading) {
      const token = this._renderToken;
      const delay = Math.max(1600, String(step.text || '').length * (this.settings.autoDelay || 55));
      this.later(() => { if (this.autoReading && token === this._renderToken && this.isIdle()) this.advance(); }, delay);
    }
  }

  isIdle() {
    return !this.paused && !this.asking && !this.waitingPause && !this.typing && !this.awaitingChoices && !this.ended;
  }

  /* ─────────────────────────── знакомство (ask) ─────────────────────────── */

  /**
   * Шаг с полем ask спрашивает значение один раз: пока переменная пустая,
   * поверх сцены висит карточка с полем ввода. Ответ уходит в переменную
   * и подставляется в текст ({имя}), а также в имя персонажа-героя.
   */
  renderAsk(step) {
    const ask = step?.ask;
    const open = !!(ask && ask.var && !this.vars[ask.var]);
    this.asking = open;
    if (!this.askLayer) return;
    this.askLayer.hidden = !open;
    this.node?.classList.toggle('is-asking', open);
    if (!open) return;
    this.askLabel.textContent = ask.label || 'Как тебя зовут?';
    if (this.askInput) {
      // перерисовка того же вопроса (после меню) не стирает начатый ответ
      const key = `${this.sceneId}:${bareId(step.id)}`;
      if (this.askInput.dataset.step !== key) this.askInput.value = '';
      this.askInput.dataset.step = key;
      this.askInput.placeholder = ask.placeholder || '';
      this.later(() => { if (this.asking) this.askInput.focus({ preventScroll: true }); }, 80);
    }
  }

  submitAsk() {
    const ask = this.step?.ask;
    if (!ask || !this.asking) return;
    const value = String(this.askInput?.value || '').trim().slice(0, 24) || String(ask.value || '').trim() || 'Гость';
    this.setVar(ask.var, value);
    this.asking = false;
    if (this.askInput) delete this.askInput.dataset.step;
    if (this.askLayer) this.askLayer.hidden = true;
    this.node?.classList.remove('is-asking');
    if (this.step.text) this.renderDialogue(this.step, { instant: true });
    else this.advance();
  }

  /* ─────────────────────────── выборы ─────────────────────────── */

  showChoices(step) {
    const choices = this.visibleChoices(step);
    if (!choices.length) return;
    // карточка сцены не должна висеть поверх вариантов
    $('.chapter-card', this.node)?.remove();
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
    if (this.paused || this.asking || this.ended) return;
    const target = resolveTarget(this.story, choice.goto, this.sceneId);
    if (!target) {
      this.opts.onBrokenLink?.(choice.goto);
      return;
    }
    this.hideChoices();
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
    if (this.paused || this.ended || this.asking) return;
    if (this.node.classList.contains('ui-hidden')) { this.node.classList.remove('ui-hidden'); return; }
    this.audio.sync();
    this.opts.onTap?.();
    if (this.settings.vibration) navigator.vibrate?.(10);
    if (this.awaitingChoices) return;
    if (this.waitingPause) {
      // тап во время паузы показывает реплику сразу, а не пропускает её
      this._pauseToken++;
      this.waitingPause = false;
      this.renderDialogue(this.step, { instant: true });
      return;
    }
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
    if (this.mode !== 'play' || scene.card === false) return;
    const old = $('.chapter-card', this.node);
    old?.remove();
    const card = el('div', { class: 'chapter-card' },
      scene.act ? el('span', { class: 'chapter-act', text: scene.act }) : null,
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
        step.text ? el('p', { class: 'ending-text', text: interpolate(step.text, this.vars) }) : null,
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
    this.audio.destroy();
    this.audio = new StoryAudio(this.story, this.settings);
    this.invalidateRender();
    this.cancelTyping();
    this.hideEnding();
    this.ended = false;
    this.opts.onRestart?.();
    this.history = [];
    this.opts.onHistory?.(this.history);
    this.resetVars();
    this.bgUrl = null;
    this.bgLayer = 0;
    this._paintedBgUrl = null;
    this.sceneId = this.story.scenes[0].id;
    this.index = 0;
    this.spriteLayer.innerHTML = '';
    this.spriteNodes.clear();
    this._spokeAt.clear();
    this._enteredAt.clear();
    this._entered = false;
    this.visual = stateAt(this.story, this.sceneId, -1, this.vars);
    this.enter(this.sceneId, 0, { instant: false });
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
