import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeStory, lintStory, VAR_NAME } from '../js/format.js';
import { storyAssets } from '../js/store.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/* Внутри .vnmy пути чувствительны к регистру, а файловые системы macOS и
 * Windows — нет. Сверяем каждую часть пути с настоящим именем в папке. */
async function assertExactCase(dir, relative) {
  let current = dir;
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    const names = await fs.readdir(current);
    if (!names.includes(part)) {
      const actual = names.find((name) => name.toLowerCase() === part.toLowerCase());
      throw new Error(actual ? `регистр в пути не совпадает: «${part}», а файл называется «${actual}»` : `нет файла: ${relative}`);
    }
    current = path.join(current, part);
  }
}
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
    await assertExactCase(dir, relative);
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
      const varNames = new Set();
      for (const v of raw.vars || []) {
        const name = String(v?.name ?? '');
        if (!VAR_NAME.test(name)) failures.push(`${label}: некорректное имя переменной «${name}» — буквы, цифры и _, первой не цифра`);
        else if (varNames.has(name)) failures.push(`${label}: переменная «${name}» объявлена дважды`);
        varNames.add(name);
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
