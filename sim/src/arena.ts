import { ARENA_RADIUS, ARENA_SEED, LAYOUT, PILLAR } from './config';
import { smoothstep, type Vec3 } from './math';
import { mulberry32, type Rng } from './rng';
import { heightAt } from './terrain';

export type SolidKind = 'wall' | 'rubble' | 'pillar' | 'slab' | 'parapet' | 'tower' | 'shifter';

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

/** A shifting wall: base pose plus `amp` displacement, eased in and held at each end. */
export interface Mover {
  base: Solid;
  amp: Vec3;
  period: number;
  phase: number;
}

/**
 * A tilted box half-buried in the ground (ruined tower, or a fallen one used as a ramp).
 * Collision is the matching stack of horizontal slices in `statics` (kind 'tower').
 */
export interface Tower {
  center: Vec3;
  /** Lean direction (radians in XZ, same convention as Solid.rot). */
  heading: number;
  /** Tilt from vertical (radians). */
  tilt: number;
  halfLength: number;
  /** Half extent along the lean direction / perpendicular to it. */
  halfWidth: number;
  halfDepth: number;
  climbable: boolean;
  style: 'tower' | 'ramp';
}

export interface Arena {
  /** Every non-moving solid, including the pillar and tower slices. */
  statics: Solid[];
  movers: Mover[];
  towers: Tower[];
  pillar: Solid | null;
  skynetAnchor: Vec3;
  spawn: { x: number; z: number };
}

export const EMPTY_ARENA: Arena = { statics: [], movers: [], towers: [], pillar: null, skynetAnchor: { x: 0, y: 10, z: 0 }, spawn: { x: 0, z: 30 } };

/** 0 at rest, 1 at full displacement; eased transitions with holds at both ends. */
export function moverShift(m: Mover, t: number): number {
  return smoothstep(-0.35, 0.35, Math.sin((2 * Math.PI * t) / m.period + m.phase));
}

export function moverOffset(m: Mover, t: number): Vec3 {
  const k = moverShift(m, t);
  return { x: m.amp.x * k, y: m.amp.y * k, z: m.amp.z * k };
}

export function moverSolid(m: Mover, t: number): Solid {
  const o = moverOffset(m, t);
  return { ...m.base, x: m.base.x + o.x, y: m.base.y + o.y, z: m.base.z + o.z };
}

export function solidTop(s: Solid): number {
  return s.y + s.height;
}

export function makeBox(kind: SolidKind, x: number, z: number, hx: number, hz: number, rot: number, bottom: number, top: number, climbable = false): Solid {
  return { kind, shape: 'box', x, y: bottom, z, height: top - bottom, hx, hz, rot, r: 0, climbable };
}

/** Unit axis of a tower (bottom → top). */
export function towerAxis(t: Tower): Vec3 {
  const s = Math.sin(t.tilt);
  return { x: s * Math.cos(t.heading), y: Math.cos(t.tilt), z: s * Math.sin(t.heading) };
}

/**
 * Horizontal slices approximating a tilted box. Each slice is the exact cross-section of the box
 * at its mid-height, so low-rise slices on a steep ramp act like a walkable slope.
 */
export function towerSlices(t: Tower, sliceHeight: number): Solid[] {
  const s = Math.sin(t.tilt);
  const c = Math.cos(t.tilt);
  const ex = Math.cos(t.heading);
  const ez = Math.sin(t.heading);
  const reach = t.halfLength * c + t.halfWidth * s;
  const start = Math.max(t.center.y - reach, heightAt(t.center.x, t.center.z) - 2);
  const out: Solid[] = [];
  for (let y = start; y < t.center.y + reach; y += sliceHeight) {
    const ym = y + sliceHeight / 2 - t.center.y;
    let u0 = (ym * s - t.halfWidth) / c;
    let u1 = (ym * s + t.halfWidth) / c;
    if (s > 1e-6) {
      u0 = Math.max(u0, (-t.halfLength - ym * c) / s);
      u1 = Math.min(u1, (t.halfLength - ym * c) / s);
    } else if (Math.abs(ym) > t.halfLength) continue;
    if (u1 - u0 < 0.2) continue;
    const um = (u0 + u1) / 2;
    out.push(makeBox('tower', t.center.x + ex * um, t.center.z + ez * um, (u1 - u0) / 2, t.halfDepth, t.heading, y, y + sliceHeight, t.climbable));
  }
  return out;
}

/** Tower from a ground point: `visible` length above the ground point, `buried` below it. */
export function towerFromBase(x: number, z: number, heading: number, tilt: number, visible: number, buried: number, halfWidth: number, halfDepth: number, climbable: boolean, style: Tower['style']): Tower {
  const t: Tower = { center: { x, y: heightAt(x, z), z }, heading, tilt, halfLength: (visible + buried) / 2, halfWidth, halfDepth, climbable, style };
  const a = towerAxis(t);
  const k = (visible - buried) / 2;
  t.center = { x: x + a.x * k, y: t.center.y + a.y * k, z: z + a.z * k };
  return t;
}

const TAU = Math.PI * 2;

/**
 * One walled fortress between two corridors, built in local coordinates (x, z >= corridor edge)
 * and mirrored by (sx, sz). A grid maze on the ground (some walls sink/rise or slide), covered
 * upper levels on slabs, parapets for cover, a ramp tower from the glade, and a leaning
 * skyscraper you can climb above Skynet.
 */
function buildQuadrant(sx: number, sz: number, rng: Rng, statics: Solid[], movers: Mover[], towers: Tower[]): void {
  const { cell, corridorHalfWidth: cw, gladeRadius, wallThickness: wt, level1, level2, slabThickness: st } = LAYOUT;
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const L1top = level1 + st;
  const L2top = level2 + st;
  const N = Math.ceil((ARENA_RADIUS - cw) / cell);
  const key = (u: number, v: number) => u * 64 + v;
  const inSet = (u: number, v: number) => {
    if (u < 0 || v < 0 || u >= N || v >= N) return false;
    const x0 = cw + u * cell;
    const z0 = cw + v * cell;
    return Math.hypot(x0, z0) >= gladeRadius && Math.hypot(x0 + cell, z0 + cell) <= ARENA_RADIUS - 2;
  };
  const cells: [number, number][] = [];
  for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) if (inSet(u, v)) cells.push([u, v]);
  const centerOf = (u: number, v: number) => ({ x: cw + (u + 0.5) * cell, z: cw + (v + 0.5) * cell });
  const world = (lx: number, lz: number) => ({ x: sx * lx, z: sz * lz });

  // Perfect maze over the cells (randomized DFS), plus extra openings for loops.
  const open = new Set<string>();
  const edgeKey = (u: number, v: number, du: number, dv: number) => (du ? `x${u + Math.min(0, du)},${v}` : `z${u},${v + Math.min(0, dv)}`);
  const visited = new Set<number>([key(...cells[0])]);
  const stack: [number, number][] = [cells[0]];
  while (stack.length) {
    const [u, v] = stack[stack.length - 1];
    const next = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).filter(([du, dv]) => inSet(u + du, v + dv) && !visited.has(key(u + du, v + dv)));
    if (!next.length) {
      stack.pop();
      continue;
    }
    const [du, dv] = next[Math.floor(rng() * next.length)];
    open.add(edgeKey(u, v, du, dv));
    visited.add(key(u + du, v + dv));
    stack.push([u + du, v + dv]);
  }
  // Cells unreachable from the first (disconnected islands) still get the loop pass below.
  for (const [u, v] of cells) {
    if (inSet(u + 1, v) && rng() < 0.15) open.add(`x${u},${v}`);
    if (inSet(u, v + 1) && rng() < 0.15) open.add(`z${u},${v}`);
  }

  // Covered levels.
  const l1 = new Set<number>();
  const l2 = new Set<number>();
  for (const [u, v] of cells) if (rng() < 0.5) l1.add(key(u, v));
  for (const k of l1) if (rng() < 0.45) l2.add(k);

  // Ramp tower from the glade up onto level 1 along the diagonal.
  let landing: [number, number] | null = null;
  for (let k = 0; k < N && !landing; k++) if (inSet(k, k)) landing = [k, k];
  const forcedOpen = new Set<string>();
  if (landing) {
    const [lu, lv] = landing;
    l1.add(key(lu, lv));
    l2.delete(key(lu, lv));
    forcedOpen.add(`L${lu},${lv}`).add(`B${lu},${lv}`);
    // The ramp's walkable (up-facing) surface is at height (u·cos + hw)/sin at offset u from the
    // base. Put the slab corner where the surface is just above slab level, so players step
    // onto the slab instead of snagging its edge, and run the ramp 2.5 m past it.
    const tilt = 58 * (Math.PI / 180);
    const s = Math.sin(tilt);
    const c = Math.cos(tilt);
    const hw = 2.5;
    const cornerR = Math.SQRT2 * (cw + lu * cell);
    // Heights are relative to the ground at the base, which depends on where the base lands.
    let baseR = cornerR - 6;
    let uCorner = 0;
    for (let i = 0; i < 3; i++) {
      const gb = world(baseR / Math.SQRT2, baseR / Math.SQRT2);
      uCorner = ((L1top + 0.1 - heightAt(gb.x, gb.z)) * s - hw) / c;
      baseR = cornerR - uCorner;
    }
    const visible = (uCorner + 2.5 + hw * c) / s;
    const b = world(baseR / Math.SQRT2, baseR / Math.SQRT2);
    // Buried deep enough that the bottom end never pokes above the ground as a ledge.
    const buried = (hw * s + 0.6) / c;
    const ramp = towerFromBase(b.x, b.z, Math.atan2(b.z, b.x), tilt, visible, buried, hw, 2.5, false, 'ramp');
    towers.push(ramp);
    statics.push(...towerSlices(ramp, 0.4));
  }

  const addWall = (lx: number, lz: number, alongZ: boolean, bottom: number, top: number, kind: 'wall' | 'parapet', climbable: boolean) => {
    const w = world(lx, lz);
    const s = makeBox(kind, w.x, w.z, cell / 2 + wt / 2, wt / 2, alongZ ? Math.PI / 2 : 0, bottom, top, climbable);
    statics.push(s);
    return s;
  };
  const addShifter = (lx: number, lz: number, alongZ: boolean, bottom: number, top: number, amp: Vec3) => {
    const w = world(lx, lz);
    movers.push({
      base: makeBox('shifter', w.x, w.z, cell / 2 + wt / 2, wt / 2, alongZ ? Math.PI / 2 : 0, bottom, top),
      amp: { x: sx * amp.x, y: amp.y, z: sz * amp.z },
      period: rand(9, 15),
      phase: rand(0, TAU),
    });
  };

  // Ground-level maze walls between cells.
  for (const [u, v] of cells) {
    for (const [du, dv] of [[1, 0], [0, 1]] as const) {
      if (!inSet(u + du, v + dv)) continue;
      const k = edgeKey(u, v, du, dv);
      if (open.has(k)) continue;
      const alongZ = du === 1;
      const lx = alongZ ? cw + (u + 1) * cell : cw + (u + 0.5) * cell;
      const lz = alongZ ? cw + (v + 0.5) * cell : cw + (v + 1) * cell;
      const g = heightAt(world(lx, lz).x, world(lx, lz).z);
      const slabAdjacent = l1.has(key(u, v)) || l1.has(key(u + du, v + dv));
      const roll = rng();
      if (roll < 0.14) {
        addShifter(lx, lz, alongZ, g - 1.5, level1, { x: 0, y: -(level1 - g + 0.4), z: 0 });
        continue;
      }
      if (roll < 0.26) {
        // Slide along the wall line into an open neighboring gap, alternating which path is blocked.
        const dirs = alongZ ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        const slide = dirs.find(([a, b]) => {
          const nu = u + a;
          const nv = v + b;
          return inSet(nu, nv) && inSet(nu + du, nv + dv) && open.has(edgeKey(nu, nv, du, dv));
        });
        if (slide) {
          addShifter(lx, lz, alongZ, g - 1.5, level1, { x: slide[0] * cell, y: 0, z: slide[1] * cell });
          continue;
        }
      }
      const climbable = rng() < 0.25;
      addWall(lx, lz, alongZ, g - 1.5, climbable && slabAdjacent ? L1top : level1, 'wall', climbable);
    }
  }

  // Outer fortress walls facing the corridors and the glade (tall, with doorways and gates).
  const exteriorTop = L1top + 2.4;
  for (const [u, v] of cells) {
    const own = centerOf(u, v);
    const sides: [number, number, boolean, number, number][] = [
      [-1, 0, true, cw + u * cell, own.z],
      [0, -1, false, own.x, cw + v * cell],
      [1, 0, true, cw + (u + 1) * cell, own.z],
      [0, 1, false, own.x, cw + (v + 1) * cell],
    ];
    for (const [du, dv, alongZ, lx, lz] of sides) {
      if (inSet(u + du, v + dv)) continue;
      const corridor = (du === -1 && u === 0) || (dv === -1 && v === 0);
      const n = centerOf(u + du, v + dv);
      const towardGlade = Math.hypot(n.x, n.z) < Math.hypot(own.x, own.z);
      if (!corridor && !towardGlade) continue; // rim side: the crater wall closes it
      if (forcedOpen.has(`${du === -1 ? 'L' : 'B'}${u},${v}`) && (du === -1 || dv === -1)) continue;
      const g = heightAt(world(lx, lz).x, world(lx, lz).z);
      const doorway = corridor ? (alongZ ? v : u) % 3 === 1 : rng() < 0.4;
      if (doorway) {
        if (rng() < 0.5) addShifter(lx, lz, alongZ, g - 1.5, exteriorTop, { x: 0, y: -(exteriorTop - g + 0.4), z: 0 });
        continue;
      }
      addWall(lx, lz, alongZ, g - 1.5, exteriorTop, 'wall', rng() < 0.25);
    }
  }

  // Level 1 and 2 slabs, upper-level walls, and parapets for cover.
  for (const [u, v] of cells) {
    const c = centerOf(u, v);
    const w = world(c.x, c.z);
    const k = key(u, v);
    if (l1.has(k)) statics.push(makeBox('slab', w.x, w.z, cell / 2, cell / 2, 0, level1, L1top));
    if (l2.has(k)) statics.push(makeBox('slab', w.x, w.z, cell / 2, cell / 2, 0, level2, L2top));
    for (const [du, dv] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const nk = key(u + du, v + dv);
      const neighbor = inSet(u + du, v + dv);
      const alongZ = du !== 0;
      const lx = alongZ ? cw + (u + (du > 0 ? 1 : 0)) * cell : c.x;
      const lz = alongZ ? c.z : cw + (v + (dv > 0 ? 1 : 0)) * cell;
      const forward = du > 0 || dv > 0; // visit shared edges once
      if (l1.has(k) && neighbor && l1.has(nk)) {
        if (forward && rng() < 0.3) {
          const roofed = l2.has(k) || l2.has(nk);
          const climbable = roofed && rng() < 0.4;
          addWall(lx, lz, alongZ, L1top, roofed ? (climbable ? L2top : level2) : L1top + 2.6, 'wall', climbable);
        }
      } else if (l1.has(k) && !(landing && k === key(...landing)) && rng() < 0.35) {
        addWall(lx, lz, alongZ, L1top, L1top + 1.3, 'parapet', false);
      }
      if (l2.has(k) && !(neighbor && l2.has(nk)) && rng() < 0.35) addWall(lx, lz, alongZ, L2top, L2top + 1.3, 'parapet', false);
    }
  }

  // A leaning ruined skyscraper, climbable, topping out above Skynet's perch.
  const a = Math.PI / 4 + rand(-0.3, 0.3);
  const r = rand(62, 76);
  const b = world(Math.cos(a) * r, Math.sin(a) * r);
  const tower = towerFromBase(b.x, b.z, rand(0, TAU), rand(12, 22) * (Math.PI / 180), 34, 14, 5, 5, true, 'tower');
  towers.push(tower);
  statics.push(...towerSlices(tower, 1));
}

/**
 * Deterministic arena: Skynet's pillar in an open glade, four open cardinal corridors (Skynet's
 * lines of attack), and four walled fortresses with covered levels and a shifting maze.
 */
export function generateArena(seed = ARENA_SEED): Arena {
  const rng = mulberry32(seed);
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const statics: Solid[] = [];
  const movers: Mover[] = [];
  const towers: Tower[] = [];

  // Central pillar holding Skynet; vines let you climb it.
  const g0 = heightAt(0, 0);
  const pillar: Solid = {
    kind: 'pillar', shape: 'cylinder', x: 0, y: g0 - 2, z: 0, height: PILLAR.height + 2,
    hx: 0, hz: 0, rot: 0, r: PILLAR.radius, climbable: true,
  };
  statics.push(pillar);

  // Glade cover: low vaultable rubble, flanking each diagonal ramp (corridor mouths stay open).
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 + (Math.floor(i / 2) * Math.PI) / 2 + (i % 2 ? 1 : -1) * rand(0.4, 0.7);
    const r = rand(10, 18);
    const g = heightAt(Math.cos(a) * r, Math.sin(a) * r);
    statics.push(makeBox('rubble', Math.cos(a) * r, Math.sin(a) * r, rand(1.4, 2.6), rand(0.6, 1.1), a + Math.PI / 2 + rand(-0.4, 0.4), g - 1, g + rand(1.4, 2.6)));
  }

  for (let q = 0; q < 4; q++) buildQuadrant(q & 1 ? -1 : 1, q & 2 ? -1 : 1, mulberry32(seed + 101 * (q + 1)), statics, movers, towers);

  return {
    statics,
    movers,
    towers,
    pillar,
    skynetAnchor: { x: 0, y: solidTop(pillar) + PILLAR.skynetHover, z: 0 },
    spawn: { x: 0, z: 88 },
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
  for (const m of arena.movers) best = raySolid(moverSolid(m, t), a, b, best);
  return best;
}
