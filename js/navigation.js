/* Searchable scene map and diagnostics shared by editor tooling. */
import { el } from './util.js';
import { openSheet } from './ui.js';
import { resolveTarget, lintStory } from './format.js';

export function openStoryNavigator(story, onSelect) {
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Найти реплику, сцену или персонажа', 'aria-label': 'Поиск по сценарию' });
  const results = el('div', { class: 'story-search-results' });
  const graph = el('div', { class: 'scene-map', 'aria-label': 'Карта переходов' });
  let close;
  const select = (sceneId, stepIndex = 0) => { close?.(); onSelect({ sceneId, stepIndex }); };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 400 ${story.scenes.length * 76 + 16}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Связи сцен; список доступен ниже');
  const defs = document.createElementNS(ns, 'defs');
  const marker = document.createElementNS(ns, 'marker');
  for (const [key, value] of Object.entries({ id: 'vnmy-map-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' })) marker.setAttribute(key, value);
  const arrow = document.createElementNS(ns, 'path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); arrow.setAttribute('fill', 'var(--accent)');
  marker.append(arrow); defs.append(marker); svg.append(defs);
  const indexes = new Map(story.scenes.map((s, i) => [s.id, i]));
  const edges = new Set();
  for (const [i, scene] of story.scenes.entries()) {
    for (const step of scene.steps) {
      const refs = [step.goto, ...(step.gotoIf || []).map(r => r.goto), ...(step.choices || []).map(c => c.goto)];
      for (const ref of refs) {
        const target = resolveTarget(story, ref, scene.id);
        const j = indexes.get(target?.sceneId);
        if (j === undefined || i === j || edges.has(`${i}:${j}`)) continue;
        edges.add(`${i}:${j}`);
        const path = document.createElementNS(ns, 'path');
        const x = j > i ? 370 : 25;
        path.setAttribute('d', `M ${j > i ? 330 : 70} ${i * 76 + 38} C ${x} ${i * 76 + 38}, ${x} ${j * 76 + 38}, ${j > i ? 330 : 70} ${j * 76 + 38}`);
        path.setAttribute('class', 'map-edge');
        path.setAttribute('marker-end', 'url(#vnmy-map-arrow)');
        svg.append(path);
      }
    }
  }
  story.scenes.forEach((scene, i) => {
    const group = document.createElementNS(ns, 'g');
    const rect = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x: 70, y: i * 76 + 12, width: 260, height: 52, rx: 12 })) rect.setAttribute(key, value);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', 86); text.setAttribute('y', i * 76 + 44);
    text.textContent = `${i + 1}. ${scene.name}`.slice(0, 29);
    group.append(rect, text);
    group.addEventListener('click', () => select(scene.id));
    svg.append(group);
  });
  graph.append(svg);
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    graph.hidden = !!query;
    results.replaceChildren();
    let found = 0;
    for (const scene of story.scenes) {
      if (!query) {
        results.append(el('button', { type: 'button', class: 'sheet-row', onclick: () => select(scene.id) }, `${scene.name} · ${scene.steps.length} реплик`));
        continue;
      }
      for (const [index, step] of scene.steps.entries()) {
        const speaker = story.characters.find(c => c.id === step.speaker)?.name || '';
        const haystack = `${scene.name} ${step.id} ${speaker} ${step.text}`.toLocaleLowerCase();
        if (!haystack.includes(query)) continue;
        found++;
        if (found <= 100) results.append(el('button', { type: 'button', class: 'sheet-row', onclick: () => select(scene.id, index) }, el('span', {}, el('strong', { text: `${scene.name} · ${index + 1}` }), el('small', { text: step.text.slice(0, 180) }))));
      }
    }
    if (query && !found) results.append(el('p', { class: 'field-hint', text: 'Ничего не найдено' }));
    if (found > 100) results.append(el('p', { class: 'field-hint', text: `Показаны первые 100 из ${found}. Уточните запрос.` }));
  };
  search.addEventListener('input', render);
  const issues = el('div', { class: 'all-diagnostics' }, el('h4', { text: 'Проверка сценария' }));
  const diagnostics = lintStory(story);
  if (!diagnostics.length) issues.append(el('p', { text: 'Ошибок не найдено' }));
  for (const issue of diagnostics) issues.append(el('button', {
    type: 'button', class: `lint-item is-${issue.level}`,
    onclick: () => { const scene = story.scenes.find(s => s.id === issue.sceneId); select(issue.sceneId, Math.max(0, scene?.steps.findIndex(s => s.id === issue.stepId) ?? 0)); },
  }, issue.text));
  render();
  close = openSheet({ title: 'Сценарий', subtitle: 'Карта сцен, поиск и все замечания', content: el('div', {}, search, graph, results, issues) });
}
