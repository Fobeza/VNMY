import { scanStories } from './build.mjs';
import { validateStories } from './validate.mjs';
const result = await validateStories(await scanStories());
console.log(`Проверено новелл: ${result.novels}; предупреждений: ${result.warnings}`);
