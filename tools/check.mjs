import { scanStories } from './build.mjs';
import { checkRoutes } from './check-routes.mjs';
import { validateStories } from './validate.mjs';
import assert from 'node:assert/strict';
import { stabilizeCast } from '../js/format.js';

// staging "stable": оставшиеся не сдвигаются, новичок занимает свободное место
const cast = (list) => list.map(([char, pos, move]) => ({ char, pos, ...(move ? { move } : {}) }));
const pos = (list) => Object.fromEntries(list.map((c) => [c.char, c.pos]));
assert.deepEqual(pos(stabilizeCast(cast([['a', 'left'], ['b', 'right']]), cast([['a', 'left'], ['b', 'center'], ['c', 'right']]))),
  { a: 'left', b: 'right', c: 'center' });
assert.deepEqual(pos(stabilizeCast(cast([['a', 'left'], ['b', 'right']]), cast([['a', 'center', true], ['b', 'right']]))),
  { a: 'center', b: 'right' });

const scan = await scanStories();
const result = await validateStories(scan);
console.log(`Проверено новелл: ${result.novels}; предупреждений: ${result.warnings}`);
const { smoke, routes } = await checkRoutes(scan);
console.log(`Самопроверки движка: ${smoke}; маршрутов новелл: ${routes}`);
