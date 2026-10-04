import { ARENA_RADIUS, TERRAIN_SEED } from './config';
import { lerp, smoothstep } from './math';

function hash(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise in [-1, 1]. */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const top = lerp(hash(ix, iz, seed), hash(ix + 1, iz, seed), ux);
  const bottom = lerp(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), ux);
  return lerp(top, bottom, uz) * 2 - 1;
}

function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 101);
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

/**
 * Ground height of the crater arena. Deterministic, so the server and bots can use it to
 * validate positions exactly as the client sees them.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Gentle undulation on the floor, flattened near the center where Skynet hovers.
  const floor = fbm(x * 0.04, z * 0.04, TERRAIN_SEED) * 2.4 * (0.35 + 0.65 * smoothstep(6, 28, r));
  const rim = smoothstep(ARENA_RADIUS - 10, ARENA_RADIUS + 4, r) * 14;
  const rimRoughness = smoothstep(ARENA_RADIUS - 10, ARENA_RADIUS + 10, r) * fbm(x * 0.08, z * 0.08, TERRAIN_SEED + 7) * 8;
  return floor + rim + rimRoughness;
}
