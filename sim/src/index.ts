// Pure game simulation shared by the browser client, the SpacetimeDB module, and the bot trainer.
// Must not import Three.js, DOM, or Node APIs, and must stay deterministic (no wall clock,
// no Math.random — use rng.ts).

export * from './config';
export * from './math';
export * from './rng';
export * from './terrain';
export * from './arena';
export * from './player';
export * from './combat';

export const BOSS_NAME = 'Skynet';
