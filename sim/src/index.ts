// Pure game simulation shared by the browser client, the SpacetimeDB module, and the bot trainer.
// Must not import Three.js, DOM, or Node APIs, and must stay deterministic (no wall clock,
// no Math.random — pass an RNG in).

export * from './config';
export * from './math';
export * from './terrain';
export * from './player';

export const BOSS_NAME = 'Skynet';
