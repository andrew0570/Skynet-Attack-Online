import { ARENA_RADIUS, ARENA_SEED, MAZE_RINGS, PILLAR } from './config';
import type { Vec3 } from './math';
import { mulberry32 } from './rng';
import { heightAt } from './terrain';

export type SolidKind = 'wall' | 'rubble' | 'pillar' | 'platform';

/** Vertical prism: a box rotated about Y, or a vertical cylinder. `y` is the bottom. */
export interface Solid {
  kind: SolidKind;
  shape: 'box' | 'cylinder';
  x: number;
  y: number;
  z: number;
  height: number;
  /** Box half-extents along its local X (length) and local Z (thickness). */
  hx: number;
  hz: number;
  /** Box rotation: local X axis points along (cos rot, sin rot) in world XZ. */
  rot: number;
  /** Cylinder radius. */
  r: number;
  climbable: boolean;
}

export interface Platform {
  /** Pose at zero offset. */
  base: Solid;
  /** Motion is base + amp * sin(2π t / period + phase). */
  amp: Vec3;
  period: number;
  phase: number;
}

export interface Arena {
  /** Every non-moving solid, including the pillar. */
  statics: Solid[];
  platforms: Platform[];
  pillar: Solid | null;
  skynetAnchor: Vec3;
  spawn: { x: number; z: number };
}

export const EMPTY_ARENA: Arena = { statics: [], platforms: [], pillar: null, skynetAnchor: { x: 0, y: 10, z: 0 }, spawn: { x: 0, z: 30 } };

export function platformOffset(p: Platform, t: number): Vec3 {
  const k = Math.sin((2 * Math.PI * t) / p.period + p.phase);
  return { x: p.amp.x * k, y: p.amp.y * k, z: p.amp.z * k };
}

export function platformSolid(p: Platform, t: number): Solid {
  const o = platformOffset(p, t);
  return { ...p.base, x: p.base.x + o.x, y: p.base.y + o.y, z: p.base.z + o.z };
}

export function solidTop(s: Solid): number {
  return s.y + s.height;
}

export function makeBox(kind: SolidKind, x: number, z: number, hx: number, hz: number, rot: number, bottom: number, top: number, climbable = false): Solid {
  return { kind, shape: 'box', x, y: bottom, z, height: top - bottom, hx, hz, rot, r: 0, climbable };
}

/** A box sitting on the terrain, `height` tall above the ground at its center. */
function grounded(kind: SolidKind, x: number, z: number, hx: number, hz: number, rot: number, height: number, climbable: boolean): Solid {
  const g = heightAt(x, z);
  return makeBox(kind, x, z, hx, hz, rot, g - 1.5, g + height, climbable);
}

const TAU = Math.PI * 2;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);

/**
 * Deterministic maze arena: a central glade around Skynet's pillar, ringed by decaying concrete
 * walls with doorways and collapsed (vaultable) sections, radial walls forming corridors, vine-
 * covered climbable walls, elevators up the pillar, and lifts/shuttles through the maze.
 */
export function generateArena(seed = ARENA_SEED): Arena {
  const rng = mulberry32(seed);
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const statics: Solid[] = [];
  const platforms: Platform[] = [];

  // Central pillar holding Skynet; vines let you climb it.
  const g0 = heightAt(0, 0);
  const pillar: Solid = {
    kind: 'pillar', shape: 'cylinder', x: 0, y: g0 - 2, z: 0, height: PILLAR.height + 2,
    hx: 0, hz: 0, rot: 0, r: PILLAR.radius, climbable: true,
  };
  statics.push(pillar);
  const pillarTop = solidTop(pillar);

  // Glade cover: low rubble blocks you can hide behind or vault (all < jump height).
  const rubbleCount = 8;
  for (let i = 0; i < rubbleCount; i++) {
    const a = (i / rubbleCount) * TAU + rand(-0.25, 0.25);
    const r = rand(11, 19);
    statics.push(grounded('rubble', Math.cos(a) * r, Math.sin(a) * r, rand(1.4, 2.8), rand(0.6, 1.1), a + Math.PI / 2 + rand(-0.4, 0.4), rand(1.4, 2.6), false));
  }

  // Concentric ring walls, approximated by straight chords.
  MAZE_RINGS.forEach((R, ringIdx) => {
    const n = Math.round((TAU * R) / 9);
    const offset = rand(0, TAU);
    const kinds: ('gap' | 'low' | 'full')[] = [];
    for (let i = 0; i < n; i++) {
      const roll = rng();
      kinds.push(roll < 0.2 ? 'gap' : roll < 0.34 ? 'low' : 'full');
    }
    // Guarantee at least three doorways per ring.
    while (kinds.filter(k => k === 'gap').length < 3) kinds[Math.floor(rng() * n)] = 'gap';

    for (let i = 0; i < n; i++) {
      if (kinds[i] === 'gap') continue;
      const half = Math.PI / n;
      const am = offset + (i / n) * TAU + half;
      const cr = R * Math.cos(half);
      const len = 2 * R * Math.sin(half);
      const low = kinds[i] === 'low';
      const height = low ? rand(1.3, 2.4) : rand(4.5, 7.5) + ringIdx * 0.3;
      const climbable = !low && rng() < 0.3;
      statics.push(grounded('wall', Math.cos(am) * cr, Math.sin(am) * cr, len / 2 + 0.3, 0.6, am + Math.PI / 2, height, climbable));
    }
  });

  // Radial walls between rings turn the annuli into corridors. Ends stop short so paths connect.
  const radialAngles: number[][] = [];
  for (let k = 0; k < MAZE_RINGS.length - 1; k++) {
    const inner = MAZE_RINGS[k];
    const outer = MAZE_RINGS[k + 1];
    const angles: number[] = [];
    const count = 3 + k * 2;
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      angles.push(a);
      const length = outer - inner - 3.5;
      const mid = (inner + outer) / 2 + rand(-0.8, 0.8);
      statics.push(grounded('wall', Math.cos(a) * mid, Math.sin(a) * mid, length / 2, 0.6, a, rand(4, 7), rng() < 0.35));
    }
    radialAngles.push(angles);
  }

  // Elevators hugging the pillar, cycling from the ground to the pillar top.
  const PLATFORM_THICKNESS = 0.4;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const r = PILLAR.radius + 2.8;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const low = heightAt(x, z) - PLATFORM_THICKNESS;
    const high = pillarTop - PLATFORM_THICKNESS;
    const mid = (low + high) / 2;
    platforms.push({
      base: makeBox('platform', x, z, 2, 2, a, mid, mid + PLATFORM_THICKNESS),
      amp: { x: 0, y: (high - low) / 2, z: 0 },
      period: 11,
      phase: (i / 3) * TAU,
    });
  }

  // Lifts beside maze walls: ride up to run along the wall tops.
  for (let i = 0; i < 6; i++) {
    const k = i % (MAZE_RINGS.length - 1);
    const R = MAZE_RINGS[k] + 3.2;
    const a = rand(0, TAU);
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const low = heightAt(x, z) - PLATFORM_THICKNESS;
    const high = low + 7.5;
    const mid = (low + high) / 2;
    platforms.push({
      base: makeBox('platform', x, z, 1.6, 1.6, a, mid, mid + PLATFORM_THICKNESS),
      amp: { x: 0, y: (high - low) / 2, z: 0 },
      period: rand(7, 10),
      phase: rand(0, TAU),
    });
  }

  // Elevated shuttles sliding along corridors (paths chosen to avoid radial walls), plus the
  // open outer run beyond the last ring.
  const shuttleLanes: { R: number; blocked: number[] }[] = [];
  for (let k = 0; k < MAZE_RINGS.length - 1; k++) shuttleLanes.push({ R: (MAZE_RINGS[k] + MAZE_RINGS[k + 1]) / 2, blocked: radialAngles[k] });
  shuttleLanes.push({ R: (MAZE_RINGS[MAZE_RINGS.length - 1] + ARENA_RADIUS) / 2, blocked: [] });
  for (let i = 0; i < 8; i++) {
    const lane = shuttleLanes[i % shuttleLanes.length];
    const amp = 7;
    const span = amp / lane.R + 0.12;
    let a = rand(0, TAU);
    for (let tries = 0; tries < 20 && lane.blocked.some(b => angleDiff(a, b) < span); tries++) a = rand(0, TAU);
    const x = Math.cos(a) * lane.R;
    const z = Math.sin(a) * lane.R;
    const y = heightAt(x, z) + rand(3.5, 5);
    platforms.push({
      base: makeBox('platform', x, z, 1.8, 1.8, a, y, y + PLATFORM_THICKNESS),
      amp: { x: -Math.sin(a) * amp, y: 0, z: Math.cos(a) * amp },
      period: rand(7, 10),
      phase: rand(0, TAU),
    });
  }

  return {
    statics,
    platforms,
    pillar,
    skynetAnchor: { x: 0, y: pillarTop + PILLAR.skynetHover, z: 0 },
    spawn: { x: 0, z: 24 },
  };
}

/** Segment a→b against one solid: hit fraction in [0, maxT), or maxT if no earlier hit. */
function raySolid(s: Solid, a: Vec3, b: Vec3, maxT: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const bottom = s.y;
  const top = s.y + s.height;
  if (s.shape === 'box') {
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    const ox = a.x - s.x;
    const oz = a.z - s.z;
    const axes: [number, number, number, number][] = [
      [ox * c + oz * sn, dx * c + dz * sn, -s.hx, s.hx],
      [a.y, dy, bottom, top],
      [-ox * sn + oz * c, -dx * sn + dz * c, -s.hz, s.hz],
    ];
    let tmin = 0;
    let tmax = maxT;
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return maxT;
        continue;
      }
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return maxT;
    }
    return tmin;
  }
  const ox = a.x - s.x;
  const oz = a.z - s.z;
  const A = dx * dx + dz * dz;
  const B = 2 * (ox * dx + oz * dz);
  const C = ox * ox + oz * oz - s.r * s.r;
  if (C <= 0) return a.y >= bottom && a.y <= top ? 0 : maxT;
  if (A < 1e-12) return maxT;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return maxT;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t < 0 || t >= maxT) return maxT;
  const y = a.y + dy * t;
  return y >= bottom && y <= top ? t : maxT;
}

/**
 * First obstruction along segment a→b at sim time t, as a fraction of the segment (1 = clear).
 * Used for line of sight (cover from Skynet's attacks) and camera collision.
 */
export function raycast(arena: Arena, a: Vec3, b: Vec3, t: number): number {
  let best = 1;
  for (const s of arena.statics) best = raySolid(s, a, b, best);
  for (const p of arena.platforms) best = raySolid(platformSolid(p, t), a, b, best);
  return best;
}
