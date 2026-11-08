import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeStory, lintStory } from '../js/format.js';
import { storyAssets } from '../js/store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export async function validateStories(scan) {
  const failures = [];
  let warnings = 0;
  const ids = new Set();
  const checkAsset = async (base, url) => {
    if (!url || /^(data:|https?:)/i.test(url)) return;
    const dir = path.resolve(ROOT, base);
    const file = path.resolve(dir, url);
    const relative = path.relative(dir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Картинка вне папки: ${url}`);
    const real = await fs.realpath(file);
    const realDir = await fs.realpath(dir);
    const realRelative = path.relative(realDir, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Картинка вне папки: ${url}`);
    await fs.access(real);
  };
  for (const { dir, path: universePath = `stories/${dir}`, single, universe, novels } of scan) {
    if (!single) {
      if (universe.id !== dir) failures.push(`${dir}: id вселенной должен совпадать с папкой`);
      try { await checkAsset(universePath, universe.cover); } catch (e) { failures.push(`${dir}: ${e.message}`); }
    }
    for (const { dir: novelDir, path: novelPath = `${universePath}/novels/${novelDir}`, story: raw } of novels) {
      const label = single ? novelDir : `${dir}/${novelDir}`;
      if (ids.has(raw.id)) failures.push(`${label}: id новеллы повторяется: ${raw.id}`);
      ids.add(raw.id);
      if (!Array.isArray(raw.scenes) || !raw.scenes.length || raw.scenes.some(s => !s || !Array.isArray(s.steps) || !s.steps.length || s.steps.some(t => !t))) {
        failures.push(`${label}: нужны непустые сцены и шаги`);
        continue;
      }
      for (const list of [raw.scenes, raw.characters || [], ...raw.scenes.map(s => s.steps)]) {
        const seen = new Set();
        for (const item of list) {
          if (!item?.id || seen.has(item.id)) failures.push(`${label}: отсутствующий или повторный id: ${item?.id}`);
          seen.add(item?.id);
        }
      }
      const story = normalizeStory(structuredClone(raw));
      const issues = lintStory(story);
      warnings += issues.filter(i => i.level !== 'error').length;
      for (const issue of issues.filter(i => i.level === 'error')) failures.push(`${label} ${issue.sceneId || ''}:${issue.stepId || ''}: ${issue.text}`);
      for (const url of storyAssets(story)) {
        try { await checkAsset(novelPath, url); }
        catch (e) { failures.push(`${label}: ${e.message}`); }
      }
    }
  }
  if (failures.length) throw new Error(`Проверка сценариев:\n${failures.join('\n')}`);
  return { warnings, novels: ids.size };
}
