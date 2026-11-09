import { scanStories, scanSource } from './build.mjs';
import { checkRoutes } from './check-routes.mjs';
import { validateStories } from './validate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stabilizeCast } from '../js/format.js';
import { checkRendering } from './check-rendering.mjs';

execFileSync(process.execPath, [new URL('./check-interface.mjs', import.meta.url).pathname], { stdio: 'inherit' });
await checkRendering();

// staging "stable": оставшиеся не сдвигаются, новичок занимает свободное место
const cast = (list) => list.map(([char, pos, move]) => ({ char, pos, ...(move ? { move } : {}) }));
const pos = (list) => Object.fromEntries(list.map((c) => [c.char, c.pos]));
assert.deepEqual(pos(stabilizeCast(cast([['a', 'left'], ['b', 'right']]), cast([['a', 'left'], ['b', 'center'], ['c', 'right']]))),
  { a: 'left', b: 'right', c: 'center' });
assert.deepEqual(pos(stabilizeCast(cast([['a', 'left'], ['b', 'right']]), cast([['a', 'center', true], ['b', 'right']]))),
  { a: 'center', b: 'right' });

// npm run check                 — движок и папки в stories/ (если есть);
// npm run check -- <папка> […]  — новелла или вселенная вне репозитория.
const sources = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const scan = sources.length
  ? (await Promise.all(sources.map((source) => scanSource(source)))).flat()
  : await scanStories();
if (sources.length && !scan.some((u) => u.novels.length)) throw new Error(`Не нашёл story.json в: ${sources.join(', ')}`);
const result = await validateStories(scan);
console.log(`Проверено новелл: ${result.novels}; предупреждений: ${result.warnings}`);
const { smoke, routes } = await checkRoutes(scan);
console.log(`Самопроверки движка: ${smoke}; маршрутов новелл: ${routes}`);
