/* Narrative state has no DOM dependencies: the player renders it. */
import { findScene, defaultVars, varByName, bareId, stateAt, stabilizeCast } from './format.js';
import { deepClone } from './util.js';
import { applyOperation } from './expr.js';

export function storyRevision(story) {
  let hash = 2166136261;
  const source = JSON.stringify([story.schema, story.vars, story.characters, story.scenes]);
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function restorePosition(story, save) {
  if (!save) return null;
  const scene = findScene(story, save.sceneId);
  if (!scene) return null;
  const id = save.stepId && bareId(save.stepId);
  const byId = id ? scene.steps.findIndex(step => bareId(step.id) === id) : -1;
  return {
    ...save,
    stepIndex: byId >= 0 ? byId : Math.max(0, Math.min(scene.steps.length - 1, Number(save.stepIndex) || 0)),
    relocated: !!id && byId < 0,
    changed: !!save.revision && save.revision !== storyRevision(story),
  };
}

export class NarrativeState {
  constructor(opts = {}) {
    this.story = opts.story;
    this.opts = opts;
    this.mode = opts.mode || 'play';
    this.sceneId = findScene(this.story, opts.start?.sceneId)?.id || this.story.scenes[0].id;
    this.index = Math.max(0, Math.min(this.scene.steps.length - 1, Number(opts.start?.stepIndex) || 0));
    this.vars = { ...defaultVars(this.story), ...(opts.vars || {}) };
    this.history = Array.isArray(opts.history) ? opts.history.slice(-150) : [];
    this.seen = opts.seen || new Set();
    this.ended = false;
    this.visual = opts.visual
      ? deepClone(opts.visual)
      : stateAt(this.story, this.sceneId, opts.resuming ? this.index : -1, this.vars);
  }
  get scene() { return findScene(this.story, this.sceneId); }
  get step() { return this.scene?.steps[this.index] || null; }
  get position() {
    return {
      sceneId: this.sceneId,
      sceneIndex: this.story.scenes.findIndex(s => s.id === this.sceneId),
      stepIndex: this.index,
      totalSteps: this.story.scenes.reduce((n, s) => n + s.steps.length, 0),
      ended: this.ended,
      vars: { ...this.vars },
      visual: deepClone(this.visual),
    };
  }
  moveTo(sceneId, index) {
    if (this.sceneId !== sceneId) this.visual = stateAt(this.story, sceneId, -1, this.vars);
    this.sceneId = sceneId;
    this.index = index;
    const step = this.step;
    if (step.bg) this.visual.bg = step.bg;
    if (step.weather) this.visual.weather = step.weather;
    if (step.cast) {
      this.visual.cast = this.story.staging === 'manual'
        ? step.cast.map(c => ({ ...c }))
        : stabilizeCast(this.visual.cast, step.cast);
    }
  }
  applySet(step) {
    for (const op of step?.set || []) {
      const type = varByName(this.story, op.var)?.type || 'number';
      this.vars[op.var] = applyOperation(this.vars[op.var] ?? (type === 'bool' ? false : type === 'text' ? '' : 0), op.op, op.value, type);
    }
    if (step?.set?.length) this.opts.onVars?.(this.vars);
  }
  setVar(name, value) { this.vars[name] = value; this.opts.onVars?.(this.vars); }
  resetVars() {
    this.vars = { ...defaultVars(this.story), ...(this.opts.initialVars || {}) };
    this.opts.onVars?.(this.vars);
  }
}
