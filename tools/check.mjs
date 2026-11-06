import { scanStories } from './build.mjs';
import { checkRoutes } from './check-routes.mjs';
import { validateStories } from './validate.mjs';

const scan = await scanStories();
const result = await validateStories(scan);
console.log(`Проверено новелл: ${result.novels}; предупреждений: ${result.warnings}`);
const { smoke, routes } = await checkRoutes(scan);
console.log(`Самопроверки движка: ${smoke}; маршрутов новелл: ${routes}`);
