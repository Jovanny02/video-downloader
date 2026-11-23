import { player, routePath } from './contract.js';
export const vidsrc = player(
  'vidsrc',
  'https://vsembed.su',
  (item) => '/embed' + routePath(item) + '?ds_lang=en&autonext=0',
);
