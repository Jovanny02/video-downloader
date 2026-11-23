import { player, routePath } from './contract.js';
export const vidfast = player('vidfast', 'https://vidfast.vc', (item) => routePath(item) + '?sub=en');
