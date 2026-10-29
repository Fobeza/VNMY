import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeStory, defaultVars, resolveTarget, lintStory, findScene } from '../js/format.js';
import { evalCondition, applyOperation, interpolate } from '../js/expr.js';
const raw = JSON.parse(await fs.readFile(new URL('../stories/pulse-right/novels/chapter-one/story.json', import.meta.url), 'utf8'));
const story = normalizeStory(raw);
assert.deepEqual(lintStory(story).filter(i => i.level === 'error'), []);
assert(story.scenes.every(s => !s.cast.some(c => c.char === 'self') && s.steps.every(t => !(t.cast || []).some(c => c.char === 'self'))), 'The protagonist must never be a normal sprite');
assert(story.scenes.every(s=>s.cast.every(c=>c.scale===1.18)), 'Character scale must stay fixed');
assert.equal(story.scenes.filter(s => /cg-/.test(s.bg)).length, 2);
assert.equal(story.characters.find(c => c.id === 'self').sprites && Object.keys(story.characters.find(c => c.id === 'self').sprites).length, 0);

function run(config = {}, random = null) {
  const vars = defaultVars(story);
  let scene = story.scenes[0], index = 0, words = 0, choiceCount = 0;
  const visited = new Set();
  for (let guard = 0; guard < 3000; guard++) {
    if (index >= scene.steps.length) {
      scene = story.scenes[story.scenes.indexOf(scene) + 1]; index = 0;
      assert(scene, 'Unexpected fall-through at end');
    }
    const step = scene.steps[index];
    if (step.if && !evalCondition(step.if, vars)) { index++; continue; }
    visited.add(`${scene.id}:${step.id}`);
    for (const op of step.set || []) {
      const type = story.vars.find(v => v.name === op.var)?.type || 'number';
      vars[op.var] = applyOperation(vars[op.var], op.op, op.value, type);
    }
    words += interpolate(step.text, vars).split(/\s+/).filter(Boolean).length;
    const options = (step.choices || []).filter(c => !c.if || evalCondition(c.if, vars));
    let target = null;
    if (options.length) {
      choiceCount++;
      const wanted = config[scene.id];
      const choice = wanted ? options.find(c => c.goto === wanted) : random ? options[Math.floor(random() * options.length)] : options[0];
      assert(choice, `Choice ${wanted} unavailable in ${scene.id}`);
      target = resolveTarget(story, choice.goto, scene.id);
    } else if (step.end) return { vars, words, choiceCount, visited, ending: step.id, title: step.endTitle };
    else {
      const rule = (step.gotoIf || []).find(r => evalCondition(r.when, vars));
      if (rule || step.goto) target = resolveTarget(story, rule?.goto || step.goto, scene.id);
    }
    if (target) { scene = findScene(story, target.sceneId); index = target.stepIndex; }
    else index++;
  }
  throw new Error('Loop or dead end');
}
const cases = [
  ['all alive, Mira', {}, 'end_all'],
  ['all alive, Asya', { rest:'talk_asya' }, 'end_all'],
  ['friendship', { rest:'talk_lev' }, 'end_all'],
  ['early surrender', { volt:'surrender' }, 'ending'],
  ['Lev dies', { depot_intro:'plan_force', gate_crisis:'cut_gate' }, 'end_lev'],
  ['Asya dies', { street:'use_terminal', departure:'split_plan', asya_crisis:'rush_asya' }, 'end_asya'],
  ['both die', { street:'use_terminal', departure:'split_plan', depot_intro:'plan_force', gate_crisis:'cut_gate', asya_crisis:'rush_asya' }, 'end_both'],
  ['body damage rescues both', { street:'use_terminal', departure:'split_plan', depot_intro:'plan_force', gate_crisis:'brace_gate', asya_crisis:'carry_asya' }, 'end_all'],
  ['manual gate safety', { depot_intro:'plan_force', gate_crisis:'lock_gate' }, 'end_all'],
  ['radio route', { depot_intro:'plan_quiet' }, 'end_all'],
  ['romance Mira kiss', { morning_mira:'mira_kiss' }, 'end_all'],
  ['romance Asya kiss', { rest:'talk_asya', morning_asya:'asya_kiss' }, 'end_all'],
  ['no external evidence', { refuse:'leave_evidence' }, 'end_all'],
  ['lie, then accountability', { diner:'lie' }, 'end_all'],
];
const report=[];
for (const [name, config, ending] of cases) {
  const result=run(config); assert.equal(result.ending, ending, name);
  assert(result.vars.charge > 0, `${name}: negative power without a narrative outcome`);
  if (ending !== 'ending') assert(result.vars.fake_id, `${name}: no identity acquired`);
  report.push({ name, words:result.words, choices:result.choiceCount, ending:result.ending });
}
const endingSet=new Set(); const visited=new Set();
let seed=4817;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296;};
for(let i=0;i<1500;i++){
 const result=run({},random); endingSet.add(result.ending); for(const key of result.visited) visited.add(key);
}
assert.equal(endingSet.size,5,'All four chapter endings and early return must be reachable');
for(const scene of story.scenes) assert(scene.steps.some(s=>visited.has(`${scene.id}:${s.id}`)),`Unreachable scene ${scene.id}`);
const normal = report.find(r=>r.name==='all alive, Mira');
assert(normal.words>=8500,`Full route too short for a one-hour chapter: ${normal.words} words`);
console.log('Pulse Right: 14 directed routes, 1500 generated routes, all 5 outcomes reachable');
console.table(report);
