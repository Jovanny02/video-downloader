import { player, wrapperOrigin } from './contract.js';
import { vidfast } from './vidfast.js';
import { vidsrc } from './vidsrc.js';
const fixture = player(
  'fixture',
  wrapperOrigin(),
  (i) => '/fixture/player/' + i.title.imdbId,
  async (frame) => {
    await frame.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 5000 });
  },
);
fixture.tracks = (frame) =>
  frame.evaluate(
    () =>
      (window as Window & { fixtureTracks?: { url: string; language: string; label: string }[] })
        .fixtureTracks ?? [],
  );
export const providers = new Map([fixture, vidfast, vidsrc].map((p) => [p.key, p]));
