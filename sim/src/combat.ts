import { raycast, type Arena } from './arena';
import { HURT_INVULN, PLAYER, SKILLS, SWORD, VITALS } from './config';
import { clamp, vec3, type Vec3 } from './math';
import { createPlayer, startRush, stepPlayer, type PlayerInput, type PlayerState } from './player';
import { mulberry32, type Rng } from './rng';
import { heightAt } from './terrain';

// ---------------------------------------------------------------------------------------------
// Skynet: tuning
// ---------------------------------------------------------------------------------------------

export const BOSS = {
  maxHp: 1200,
  /** Hit radius of the core + blade ring (as rendered at 2x scale). */
  radius: 3.2,
  maxEnergy: 100,
  /** Energy per second. With attack costs of 20-40 this caps sustained attacks at ~1 per 3 s. */
  energyRegen: 9,
  /** Minimum pause after every attack before the next decision. */
  globalCooldown: 0.5,
  /** Damage multiplier while stunned on the ground after a Dive Slam. */
  stunnedMultiplier: 1.5,
};

export type AttackId = 'volley' | 'spread' | 'homing' | 'mortar' | 'sweep' | 'dive';
/** direct: where you are · lead: where you're heading · flank: lead, offset toward your usual dodge side. */
export type AimMode = 'direct' | 'lead' | 'flank';

interface AttackSpec {
  cost: number;
  telegraph: number;
  active: number;
  recover: number;
}

export const ATTACKS: Record<AttackId, AttackSpec> = {
  volley: { cost: 22, telegraph: 0.55, active: 0.6, recover: 0.4 },
  spread: { cost: 28, telegraph: 0.65, active: 0.05, recover: 0.5 },
  homing: { cost: 34, telegraph: 0.8, active: 0.5, recover: 0.6 },
  mortar: { cost: 30, telegraph: 0.6, active: 0.45, recover: 0.6 },
  sweep: { cost: 20, telegraph: 0.6, active: 0.3, recover: 0.6 },
  dive: { cost: 40, telegraph: 0.9, active: 0.7, recover: 2.4 },
};

const PROJ = {
  volley: { speed: 42, damage: 12, radius: 0.35, shots: 5 },
  spread: { speed: 30, damage: 8, radius: 0.35, shots: 7, fan: 0.55 },
  homing: { speed: 13, damage: 18, radius: 0.6, shots: 3, turn: 1.6, ttl: 7 },
  /** Lobbed upward at `launchVy` so shells peak high and drop steeply behind cover. */
  mortar: { launchVy: 22, gravity: 24, damage: 22, radius: 0.5, aoe: 4.5, shells: 4, scatter: 3.5 },
};
const SWEEP = { range: 8.5, damage: 25, knockback: 18 };
const DIVE = { aoe: 7, damage: 30, knockback: 16, hoverHeight: 2.2, returnTime: 1.0 };

/** One of Skynet's choices. The brain picks an arm index each time Skynet is ready to act. */
export type Arm = { kind: 'wait'; duration: number } | { kind: 'attack'; attack: AttackId; aim: AimMode };

const AIMS: AimMode[] = ['direct', 'lead', 'flank'];
export const ARMS: Arm[] = [
  { kind: 'wait', duration: 0.5 },
  ...(['volley', 'spread', 'homing', 'mortar'] as const).flatMap(attack => AIMS.map(aim => ({ kind: 'attack' as const, attack, aim }))),
  { kind: 'attack', attack: 'sweep', aim: 'direct' },
  { kind: 'attack', attack: 'dive', aim: 'direct' },
  { kind: 'attack', attack: 'dive', aim: 'lead' },
];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type BossPhase = 'idle' | 'telegraph' | 'active' | 'recover' | 'return';

export interface BossState {
  pos: Vec3;
  perch: Vec3;
  hp: number;
  energy: number;
  phase: BossPhase;
  /** Seconds left in the current phase. */
  timer: number;
  /** Pause before the next decision (global cooldown or a chosen wait). */
  cooldown: number;
  /** Current arm index, or -1. */
  arm: number;
  /** Aim point locked at telegraph start (for the telegraph and the Dive target). */
  aim: Vec3;
  shotsFired: number;
  diveFrom: Vec3;
  /** Decision index (in fight.decisions) of the current action. */
  decision: number;
}

export type ProjectileKind = 'bolt' | 'orb' | 'shell';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  pos: Vec3;
  vel: Vec3;
  ttl: number;
  damage: number;
  radius: number;
  /** Area damage radius on impact (0 = direct hit only). */
  aoe: number;
  gravity: number;
  /** Homing turn rate (rad/s), 0 = none. */
  homing: number;
  /** Mortar landing point (for ground markers). */
  target: Vec3 | null;
  /** Decision that fired it (credit for M4 rewards). */
  decision: number;
}

/** One Skynet decision and what came of it — the learning brain's training sample. */
export interface Decision {
  time: number;
  arm: number;
  /** The context (feature vector) Skynet saw when it decided. */
  context: number[];
  /** Energy spent. */
  cost: number;
  /** Damage Skynet dealt to the player because of this decision (its projectiles/hits). */
  dealt: number;
  /** Damage Skynet took from this decision until the next one. */
  taken: number;
  /** When the next decision was made (Infinity until then). */
  windowEnd: number;
  /** Scored once its window ended and all its projectiles resolved (forced at fight end). */
  resolved: boolean;
  reward: number;
}

export type FightEvent =
  | { type: 'telegraph'; attack: AttackId; aim: Vec3; markers: Vec3[] }
  | { type: 'fire'; attack: AttackId }
  | { type: 'impact'; pos: Vec3; radius: number; kind: ProjectileKind }
  | { type: 'sweep'; pos: Vec3; radius: number }
  | { type: 'slam'; pos: Vec3; radius: number }
  | { type: 'playerHit'; damage: number; armor: number; health: number; pos: Vec3 }
  | { type: 'dodged'; pos: Vec3 }
  | { type: 'bossHit'; damage: number; stunned: boolean }
  | { type: 'won' }
  | { type: 'lost' }
  | { type: 'lightningCast'; pos: Vec3 }
  | { type: 'lightning'; pos: Vec3; hit: boolean }
  | { type: 'rush' }
  | { type: 'beamFired'; from: Vec3 }
  | { type: 'beamImpact'; pos: Vec3; hitBoss: boolean };

/** Player's sword-beam projectile. */
export interface PlayerShot {
  id: number;
  pos: Vec3;
  vel: Vec3;
  ttl: number;
}

export interface FightState {
  time: number;
  player: PlayerState;
  /** Never regenerates; 0 = defeat. */
  health: number;
  /** Absorbs damage first; regenerates after VITALS.armorRegenDelay without being hit. */
  armor: number;
  /** Seconds until armor starts regenerating. */
  armorDelay: number;
  hurt: number;
  boss: BossState;
  projectiles: Projectile[];
  nextId: number;
  outcome: 'active' | 'won' | 'lost';
  rng: Rng;
  /** Which side (+1/-1, relative to Skynet's line of fire) the player dashed to most recently. */
  dodgeSide: number;
  decisions: Decision[];
  /** Recent Skynet attack outcomes on the player: 1 = dodged (i-frames), 0 = hit. Newest last. */
  recentDodges: number[];
  /** Seconds left on each skill's cooldown, in SKILL_ORDER (lightning, rush, beam). */
  skillCd: number[];
  /** Lightning strike waiting to land. */
  lightning: { pos: Vec3; timer: number } | null;
  /** Blade Rush hit cadence. */
  rushHitTimer: number;
  rushHits: number;
  shots: PlayerShot[];
}

/**
 * Picks an arm index from `valid` (all valid for the current state). `context` is the feature
 * vector for this decision (see brain.ts), recorded with the decision for learning.
 */
export type Brain = (f: FightState, arena: Arena, valid: number[], context: number[]) => number;

/** Feature extractor, injected by brain.ts (avoids a circular import). */
let contextOf: (f: FightState, arena: Arena) => number[] = () => [];
export function setContextExtractor(fn: (f: FightState, arena: Arena) => number[]): void {
  contextOf = fn;
}

const RECENT_DODGES = 8;
function recordDodge(f: FightState, dodged: boolean): void {
  f.recentDodges.push(dodged ? 1 : 0);
  if (f.recentDodges.length > RECENT_DODGES) f.recentDodges.shift();
}

export function createFight(arena: Arena, seed = 1): FightState {
  const perch = { ...arena.skynetAnchor };
  return {
    time: 0,
    player: createPlayer(arena.spawn.x, arena.spawn.z),
    health: VITALS.health,
    armor: VITALS.armor,
    armorDelay: 0,
    hurt: 0,
    boss: {
      pos: { ...perch }, perch, hp: BOSS.maxHp, energy: BOSS.maxEnergy * 0.6, phase: 'idle', timer: 0,
      cooldown: 2, arm: -1, aim: vec3(), shotsFired: 0, diveFrom: { ...perch }, decision: -1,
    },
    projectiles: [],
    nextId: 1,
    outcome: 'active',
    rng: mulberry32(seed),
    dodgeSide: 1,
    decisions: [],
    recentDodges: [],
    skillCd: [0, 0, 0],
    lightning: null,
    rushHitTimer: 0,
    rushHits: 0,
    shots: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

export function playerChest(p: PlayerState): Vec3 {
  return { x: p.pos.x, y: p.pos.y + 1.1, z: p.pos.z };
}

/** Can Skynet see the player's chest from where it is? */
export function bossCanSee(f: FightState, arena: Arena): boolean {
  return raycast(arena, f.boss.pos, playerChest(f.player), f.time) >= 1;
}

/** Distance from a point to the player's body (vertical segment, feet+0.3 to head-0.2). */
function distToPlayer(p: PlayerState, q: Vec3): number {
  const y = clamp(q.y, p.pos.y + 0.3, p.pos.y + PLAYER.height - 0.2);
  return Math.hypot(q.x - p.pos.x, q.y - y, q.z - p.pos.z);
}

/** Where to shoot, given an aim mode and how long the shot takes to arrive. */
function aimPoint(f: FightState, mode: AimMode, flightTime: number): Vec3 {
  const p = f.player;
  const chest = playerChest(p);
  if (mode === 'direct') return chest;
  const lead = { x: chest.x + p.vel.x * flightTime, y: chest.y + p.vel.y * flightTime * 0.5, z: chest.z + p.vel.z * flightTime };
  if (mode === 'lead') return lead;
  // Flank: shift sideways (perpendicular to the line of fire) toward the side they dodge to.
  const d = sub(lead, f.boss.pos);
  const h = Math.hypot(d.x, d.z) || 1;
  return { x: lead.x + (-d.z / h) * 3.5 * f.dodgeSide, y: lead.y, z: lead.z + (d.x / h) * 3.5 * f.dodgeSide };
}

function flightTimeTo(f: FightState, speed: number): number {
  return len(sub(playerChest(f.player), f.boss.pos)) / speed;
}

/** Time for a lobbed shell to fall from `drop` meters above its target. */
function mortarFlightTime(drop: number): number {
  const { launchVy: v, gravity: g } = PROJ.mortar;
  return (v + Math.sqrt(Math.max(0, v * v + 2 * g * drop))) / g;
}

export function validArms(f: FightState): number[] {
  const b = f.boss;
  const toPlayer = len(sub(playerChest(f.player), b.pos));
  const horiz = Math.hypot(f.player.pos.x - b.perch.x, f.player.pos.z - b.perch.z);
  const out: number[] = [];
  ARMS.forEach((arm, i) => {
    if (arm.kind === 'wait') return out.push(i);
    if (b.energy < ATTACKS[arm.attack].cost) return;
    if (arm.attack === 'sweep' && toPlayer > SWEEP.range + 1.5) return;
    if (arm.attack === 'dive' && horiz > 75) return;
    out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------------------------

function damagePlayer(f: FightState, amount: number, from: Vec3, decision: number, events: FightEvent[], knockback = 0): void {
  if (f.outcome !== 'active') return;
  const p = f.player;
  if (p.invuln > 0 || f.hurt > 0) {
    if (p.invuln > 0) {
      events.push({ type: 'dodged', pos: { ...p.pos } });
      recordDodge(f, true);
    }
    return;
  }
  recordDodge(f, false);
  // Armor absorbs first; the overflow hits health.
  const toArmor = Math.min(amount, f.armor);
  const toHealth = Math.min(amount - toArmor, f.health);
  f.armor -= toArmor;
  f.health -= toHealth;
  f.armorDelay = VITALS.armorRegenDelay;
  const dealt = toArmor + toHealth;
  f.hurt = HURT_INVULN;
  if (decision >= 0) f.decisions[decision].dealt += dealt;
  events.push({ type: 'playerHit', damage: dealt, armor: toArmor, health: toHealth, pos: { ...p.pos } });
  if (knockback > 0) {
    const d = sub(p.pos, from);
    const h = Math.hypot(d.x, d.z) || 1;
    p.vel.x = (d.x / h) * knockback;
    p.vel.z = (d.z / h) * knockback;
    p.vel.y = 8;
    p.onGround = false;
    p.climbing = false;
  }
  if (f.health <= 0) {
    f.outcome = 'lost';
    events.push({ type: 'lost' });
  }
}

function damageBoss(f: FightState, amount: number, events: FightEvent[]): void {
  if (f.outcome !== 'active') return;
  const b = f.boss;
  const stunned = b.phase === 'recover' && b.arm >= 0 && (ARMS[b.arm] as { attack?: AttackId }).attack === 'dive';
  const dmg = Math.min(b.hp, amount * (stunned ? BOSS.stunnedMultiplier : 1));
  b.hp -= dmg;
  if (b.decision >= 0) f.decisions[b.decision].taken += dmg;
  events.push({ type: 'bossHit', damage: dmg, stunned });
  if (b.hp <= 0) {
    f.outcome = 'won';
    events.push({ type: 'won' });
  }
}

/** Area damage with linear falloff to 50% at the edge. */
function areaDamage(f: FightState, center: Vec3, radius: number, damage: number, decision: number, events: FightEvent[], knockback = 0): void {
  const d = distToPlayer(f.player, center);
  if (d > radius) return;
  damagePlayer(f, damage * (1 - 0.5 * (d / radius)), center, decision, events, knockback);
}

// ---------------------------------------------------------------------------------------------
// Skynet actions
// ---------------------------------------------------------------------------------------------

function spawn(f: FightState, p: Omit<Projectile, 'id'>): void {
  f.projectiles.push({ ...p, id: f.nextId++ });
}

function muzzle(f: FightState, toward: Vec3): Vec3 {
  return add(f.boss.pos, norm(sub(toward, f.boss.pos)), BOSS.radius * 0.7);
}

function startAction(f: FightState, armIndex: number, context: number[], events: FightEvent[]): void {
  const b = f.boss;
  const arm = ARMS[armIndex];
  b.arm = armIndex;
  // The previous decision's damage-taken window closes now.
  if (f.decisions.length) f.decisions[f.decisions.length - 1].windowEnd = f.time;
  const cost = arm.kind === 'attack' ? ATTACKS[arm.attack].cost : 0;
  f.decisions.push({ time: f.time, arm: armIndex, context, cost, dealt: 0, taken: 0, windowEnd: Infinity, resolved: false, reward: 0 });
  b.decision = f.decisions.length - 1;
  if (arm.kind === 'wait') {
    b.cooldown = arm.duration;
    return;
  }
  const spec = ATTACKS[arm.attack];
  b.energy -= spec.cost;
  b.phase = 'telegraph';
  b.timer = spec.telegraph;
  b.shotsFired = 0;
  const speed = arm.attack === 'volley' ? PROJ.volley.speed : arm.attack === 'spread' ? PROJ.spread.speed : arm.attack === 'homing' ? PROJ.homing.speed : 0;
  const t = speed
    ? flightTimeTo(f, speed) + spec.telegraph
    : arm.attack === 'mortar'
      ? mortarFlightTime(b.pos.y - f.player.pos.y) + spec.telegraph
      : spec.telegraph + spec.active;
  b.aim = aimPoint(f, arm.aim, t);
  const markers: Vec3[] = [];
  if (arm.attack === 'dive') {
    b.aim = { x: b.aim.x, y: heightAt(b.aim.x, b.aim.z), z: b.aim.z };
    markers.push(b.aim);
  }
  events.push({ type: 'telegraph', attack: arm.attack, aim: { ...b.aim }, markers });
}

function fire(f: FightState, arena: Arena, events: FightEvent[]): void {
  const b = f.boss;
  const arm = ARMS[b.arm];
  if (arm.kind !== 'attack') return;
  const spec = ATTACKS[arm.attack];
  const elapsed = spec.active - b.timer;
  switch (arm.attack) {
    case 'volley': {
      // Five bolts spread over the active window, each re-aimed (tracking) with the chosen mode.
      const due = Math.min(PROJ.volley.shots, Math.floor((elapsed / spec.active) * PROJ.volley.shots) + 1);
      while (b.shotsFired < due) {
        const target = aimPoint(f, arm.aim, flightTimeTo(f, PROJ.volley.speed));
        const from = muzzle(f, target);
        spawn(f, { kind: 'bolt', pos: from, vel: add(vec3(), norm(sub(target, from)), PROJ.volley.speed), ttl: 4, damage: PROJ.volley.damage, radius: PROJ.volley.radius, aoe: 0, gravity: 0, homing: 0, target: null, decision: b.decision });
        b.shotsFired++;
        if (b.shotsFired === 1) events.push({ type: 'fire', attack: 'volley' });
      }
      break;
    }
    case 'spread': {
      if (b.shotsFired) break;
      const target = aimPoint(f, arm.aim, flightTimeTo(f, PROJ.spread.speed));
      const from = muzzle(f, target);
      const dir = norm(sub(target, from));
      const base = Math.atan2(dir.z, dir.x);
      const h = Math.hypot(dir.x, dir.z);
      for (let i = 0; i < PROJ.spread.shots; i++) {
        const a = base + PROJ.spread.fan * ((i / (PROJ.spread.shots - 1)) * 2 - 1);
        const v = { x: Math.cos(a) * h, y: dir.y, z: Math.sin(a) * h };
        spawn(f, { kind: 'bolt', pos: from, vel: add(vec3(), v, PROJ.spread.speed), ttl: 4, damage: PROJ.spread.damage, radius: PROJ.spread.radius, aoe: 0, gravity: 0, homing: 0, target: null, decision: b.decision });
      }
      b.shotsFired = PROJ.spread.shots;
      events.push({ type: 'fire', attack: 'spread' });
      break;
    }
    case 'homing': {
      const due = Math.min(PROJ.homing.shots, Math.floor((elapsed / spec.active) * PROJ.homing.shots) + 1);
      while (b.shotsFired < due) {
        const target = aimPoint(f, arm.aim, flightTimeTo(f, PROJ.homing.speed));
        // Fan the launch directions so the orbs converge from different angles.
        const side = (b.shotsFired - 1) * 0.6;
        const from = muzzle(f, target);
        const d = norm(sub(target, from));
        const v = norm({ x: d.x - d.z * side, y: d.y + 0.35, z: d.z + d.x * side });
        spawn(f, { kind: 'orb', pos: from, vel: add(vec3(), v, PROJ.homing.speed), ttl: PROJ.homing.ttl, damage: PROJ.homing.damage, radius: PROJ.homing.radius, aoe: 0, gravity: 0, homing: PROJ.homing.turn, target: null, decision: b.decision });
        b.shotsFired++;
        if (b.shotsFired === 1) events.push({ type: 'fire', attack: 'homing' });
      }
      break;
    }
    case 'mortar': {
      if (b.shotsFired) break;
      const g = PROJ.mortar.gravity;
      const center = aimPoint(f, arm.aim, mortarFlightTime(b.pos.y - f.player.pos.y));
      const markers: Vec3[] = [];
      for (let i = 0; i < PROJ.mortar.shells; i++) {
        const r = i === 0 ? 0 : PROJ.mortar.scatter * (0.4 + 0.6 * f.rng());
        const a = f.rng() * Math.PI * 2;
        const tx = center.x + Math.cos(a) * r;
        const tz = center.z + Math.sin(a) * r;
        const target = { x: tx, y: heightAt(tx, tz), z: tz };
        // Ballistic lob: fixed upward launch speed; horizontal speed chosen to land on target.
        const from = { x: b.pos.x, y: b.pos.y + 1.5, z: b.pos.z };
        const T = mortarFlightTime(from.y - target.y);
        const vel = { x: (target.x - from.x) / T, y: PROJ.mortar.launchVy, z: (target.z - from.z) / T };
        spawn(f, { kind: 'shell', pos: from, vel, ttl: T + 1, damage: PROJ.mortar.damage, radius: PROJ.mortar.radius, aoe: PROJ.mortar.aoe, gravity: g, homing: 0, target, decision: b.decision });
        markers.push(target);
      }
      b.shotsFired = PROJ.mortar.shells;
      events.push({ type: 'fire', attack: 'mortar' });
      events.push({ type: 'telegraph', attack: 'mortar', aim: center, markers });
      break;
    }
    case 'sweep': {
      if (b.shotsFired) break;
      b.shotsFired = 1;
      events.push({ type: 'sweep', pos: { ...b.pos }, radius: SWEEP.range });
      if (len(sub(playerChest(f.player), b.pos)) <= SWEEP.range) damagePlayer(f, SWEEP.damage, b.pos, b.decision, events, SWEEP.knockback);
      break;
    }
    case 'dive': {
      // Fly from the perch to just above the target along an arc; slam on arrival.
      const k = clamp(elapsed / spec.active, 0, 1);
      const e = k * k;
      const to = { x: b.aim.x, y: b.aim.y + DIVE.hoverHeight, z: b.aim.z };
      b.pos = { x: b.diveFrom.x + (to.x - b.diveFrom.x) * e, y: b.diveFrom.y + (to.y - b.diveFrom.y) * e + Math.sin(k * Math.PI) * 4, z: b.diveFrom.z + (to.z - b.diveFrom.z) * e };
      if (k >= 1 && !b.shotsFired) {
        b.shotsFired = 1;
        events.push({ type: 'slam', pos: { ...b.aim }, radius: DIVE.aoe });
        areaDamage(f, b.aim, DIVE.aoe, DIVE.damage, b.decision, events, DIVE.knockback);
      }
      break;
    }
  }
}

function stepBoss(f: FightState, arena: Arena, dt: number, brain: Brain, events: FightEvent[]): void {
  const b = f.boss;
  b.energy = Math.min(BOSS.maxEnergy, b.energy + BOSS.energyRegen * dt);
  b.cooldown = Math.max(0, b.cooldown - dt);

  switch (b.phase) {
    case 'idle':
      if (b.cooldown <= 0 && f.outcome === 'active') {
        const context = contextOf(f, arena);
        const valid = validArms(f);
        let arm = brain(f, arena, valid, context);
        if (!valid.includes(arm)) arm = valid[0]; // never let a brain pick an invalid arm
        startAction(f, arm, context, events);
      }
      break;
    case 'telegraph':
      b.timer -= dt;
      if (b.timer <= 0) {
        const arm = ARMS[b.arm] as { attack: AttackId };
        b.phase = 'active';
        b.timer = ATTACKS[arm.attack].active;
        b.diveFrom = { ...b.pos };
      }
      break;
    case 'active':
      b.timer -= dt;
      fire(f, arena, events);
      if (b.timer <= 0) {
        fire(f, arena, events); // flush any shots due at the very end
        const arm = ARMS[b.arm] as { attack: AttackId };
        b.phase = 'recover';
        b.timer = ATTACKS[arm.attack].recover;
      }
      break;
    case 'recover':
      b.timer -= dt;
      if (b.timer <= 0) {
        const arm = ARMS[b.arm] as { attack: AttackId };
        if (arm.attack === 'dive') {
          b.phase = 'return';
          b.timer = DIVE.returnTime;
          b.diveFrom = { ...b.pos };
        } else {
          b.phase = 'idle';
          b.cooldown = BOSS.globalCooldown;
        }
      }
      break;
    case 'return': {
      b.timer -= dt;
      const k = 1 - Math.max(0, b.timer) / DIVE.returnTime;
      const e = k * (2 - k);
      b.pos = { x: b.diveFrom.x + (b.perch.x - b.diveFrom.x) * e, y: b.diveFrom.y + (b.perch.y - b.diveFrom.y) * e, z: b.diveFrom.z + (b.perch.z - b.diveFrom.z) * e };
      if (b.timer <= 0) {
        b.pos = { ...b.perch };
        b.phase = 'idle';
        b.cooldown = BOSS.globalCooldown;
      }
      break;
    }
  }
}

function stepProjectiles(f: FightState, arena: Arena, dt: number, events: FightEvent[]): void {
  const chest = playerChest(f.player);
  const keep: Projectile[] = [];
  for (const pr of f.projectiles) {
    pr.ttl -= dt;
    if (pr.homing > 0) {
      // Turn toward the player at a limited rate, keeping speed.
      const speed = len(pr.vel);
      const want = norm(sub(chest, pr.pos));
      const cur = norm(pr.vel);
      const dot = clamp(cur.x * want.x + cur.y * want.y + cur.z * want.z, -1, 1);
      const angle = Math.acos(dot);
      const k = angle > 1e-4 ? Math.min(1, (pr.homing * dt) / angle) : 0;
      pr.vel = add(vec3(), norm(add(cur, sub(want, cur), k)), speed);
    }
    pr.vel.y -= pr.gravity * dt;
    const next = add(pr.pos, pr.vel, dt);

    // Player hit (direct).
    if (distToPlayer(f.player, next) <= pr.radius + 0.45) {
      if (pr.aoe > 0) {
        events.push({ type: 'impact', pos: next, radius: pr.aoe, kind: pr.kind });
        areaDamage(f, next, pr.aoe, pr.damage, pr.decision, events);
      } else {
        events.push({ type: 'impact', pos: next, radius: pr.radius * 2, kind: pr.kind });
        damagePlayer(f, pr.damage, pr.pos, pr.decision, events);
      }
      continue;
    }
    // World hit: walls/roofs block projectiles (that's what makes cover work).
    const t = raycast(arena, pr.pos, next, f.time);
    const ground = heightAt(next.x, next.z);
    if (t < 1 || next.y <= ground) {
      const hit = t < 1 ? add(pr.pos, sub(next, pr.pos), t) : { x: next.x, y: ground, z: next.z };
      events.push({ type: 'impact', pos: hit, radius: pr.aoe || pr.radius * 2, kind: pr.kind });
      if (pr.aoe > 0) areaDamage(f, hit, pr.aoe, pr.damage, pr.decision, events);
      continue;
    }
    pr.pos = next;
    if (pr.ttl > 0) keep.push(pr);
  }
  f.projectiles = keep;
}

/** Resolve the player's sword swing against Skynet. */
function stepSword(f: FightState, events: FightEvent[]): void {
  const p = f.player;
  if (p.swingHit || p.swingTimer <= 0) return;
  const progress = 1 - p.swingTimer / SWORD.swingTime;
  if (progress < SWORD.hitAt) return;
  p.swingHit = true;
  const chest = playerChest(p);
  const d = sub(f.boss.pos, chest);
  if (len(d) > SWORD.reach + BOSS.radius) return;
  const h = Math.hypot(d.x, d.z);
  if (h > 2) {
    let diff = Math.atan2(d.x, d.z) - p.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (Math.abs(diff) > SWORD.arcHalf) return;
  }
  damageBoss(f, SWORD.damage[p.comboStep], events);
}

// ---------------------------------------------------------------------------------------------
// Player skills
// ---------------------------------------------------------------------------------------------

const AIM_RANGE = 150;

/** Distance along a ray (unit dir) to a sphere, or Infinity. */
function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc <= 0 ? 0 : Infinity;
}

/**
 * What the reticle points at: the first of Skynet, walls/roofs, or terrain along the camera's
 * center ray (from `eye` along unit `look`). Falls back to a far point if it hits nothing.
 */
export function aimRay(f: FightState, arena: Arena, eye: Vec3, look: Vec3): { point: Vec3; hitBoss: boolean; dist: number } {
  const dir = norm(look);
  let best = AIM_RANGE;
  let hitBoss = false;
  const tBoss = raySphere(eye, dir, f.boss.pos, BOSS.radius);
  if (tBoss < best) {
    best = tBoss;
    hitBoss = true;
  }
  const tSolid = raycast(arena, eye, add(eye, dir, AIM_RANGE), f.time) * AIM_RANGE;
  if (tSolid < best) {
    best = tSolid;
    hitBoss = false;
  }
  // Terrain: march, then bisect.
  for (let t = 1; t < best; t += 1) {
    const q = add(eye, dir, t);
    if (q.y <= heightAt(q.x, q.z)) {
      let lo = t - 1;
      let hi = t;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const m = add(eye, dir, mid);
        if (m.y <= heightAt(m.x, m.z)) hi = mid;
        else lo = mid;
      }
      best = hi;
      hitBoss = false;
      break;
    }
  }
  return { point: add(eye, dir, best), hitBoss, dist: best };
}

function castLightning(f: FightState, arena: Arena, eye: Vec3, look: Vec3, events: FightEvent[]): void {
  const p = f.player;
  const L = SKILLS.lightning;
  const aim = aimRay(f, arena, eye, look);
  // Strike column under the aim point, clamped to medium range in front of the player.
  let tx = aim.point.x - p.pos.x;
  let tz = aim.point.z - p.pos.z;
  let d = Math.hypot(tx, tz);
  if (d < 1e-3) {
    tx = look.x;
    tz = look.z;
    d = Math.hypot(tx, tz) || 1;
    tx = (tx / d) * L.minRange;
    tz = (tz / d) * L.minRange;
    d = L.minRange;
  }
  const r = clamp(d, L.minRange, L.maxRange);
  const x = p.pos.x + (tx / d) * r;
  const z = p.pos.z + (tz / d) * r;
  const inRange = r === d;
  const y = inRange && !aim.hitBoss ? Math.max(heightAt(x, z), aim.point.y) : heightAt(x, z);
  f.lightning = { pos: { x, y, z }, timer: L.castTime };
  events.push({ type: 'lightningCast', pos: { x, y, z } });
}

function strikeLightning(f: FightState, events: FightEvent[]): void {
  const L = SKILLS.lightning;
  const pos = f.lightning!.pos;
  f.lightning = null;
  // A vertical column from the sky: hits Skynet anywhere above the strike point.
  const b = f.boss.pos;
  const hit = Math.hypot(b.x - pos.x, b.z - pos.z) <= L.radius + BOSS.radius * 0.5 && b.y >= pos.y - 2;
  events.push({ type: 'lightning', pos, hit });
  if (hit) damageBoss(f, L.damage, events);
}

function fireBeam(f: FightState, arena: Arena, eye: Vec3, look: Vec3, events: FightEvent[]): void {
  const p = f.player;
  const B = SKILLS.beam;
  // Leaves from the sword hand (right side, chest height) toward the reticle point.
  const right = { x: -Math.cos(p.yaw), z: Math.sin(p.yaw) };
  const from = { x: p.pos.x + right.x * 0.45, y: p.pos.y + 1.2, z: p.pos.z + right.z * 0.45 };
  const target = aimRay(f, arena, eye, look).point;
  const dir = norm(sub(target, from));
  f.shots.push({ id: f.nextId++, pos: from, vel: add(vec3(), dir, B.speed), ttl: B.ttl });
  // Face the shot.
  if (Math.hypot(dir.x, dir.z) > 0.1) p.yaw = Math.atan2(dir.x, dir.z);
  events.push({ type: 'beamFired', from });
}

function stepSkills(f: FightState, arena: Arena, input: PlayerInput, dt: number, events: FightEvent[]): void {
  const p = f.player;
  for (let i = 0; i < 3; i++) f.skillCd[i] = Math.max(0, f.skillCd[i] - dt);
  const eye = { x: input.eyeX, y: input.eyeY, z: input.eyeZ };
  const look = { x: input.lookX, y: input.lookY, z: input.lookZ };
  const k = input.skill - 1;
  if (k >= 0 && k < 3 && f.skillCd[k] <= 0 && !p.climbing) {
    if (k === 0) castLightning(f, arena, eye, look, events);
    if (k === 1) {
      startRush(p, norm(look));
      f.rushHitTimer = 0;
      f.rushHits = 0;
      events.push({ type: 'rush' });
    }
    if (k === 2) fireBeam(f, arena, eye, look, events);
    f.skillCd[k] = [SKILLS.lightning.cooldown, SKILLS.rush.cooldown, SKILLS.beam.cooldown][k];
  }

  if (f.lightning) {
    f.lightning.timer -= dt;
    if (f.lightning.timer <= 0) strikeLightning(f, events);
  }

  // Blade Rush: slash anything within reach along the charge, on a fixed cadence.
  if (p.rushing) {
    f.rushHitTimer -= dt;
    if (f.rushHitTimer <= 0 && f.rushHits < SKILLS.rush.maxHits && len(sub(f.boss.pos, playerChest(p))) <= SKILLS.rush.reach + BOSS.radius) {
      damageBoss(f, SKILLS.rush.damage, events);
      f.rushHits++;
      f.rushHitTimer = SKILLS.rush.hitInterval;
    }
  }

  // Sword beams: hit Skynet (segment vs sphere), walls, or terrain.
  const keep: PlayerShot[] = [];
  for (const s of f.shots) {
    s.ttl -= dt;
    const next = add(s.pos, s.vel, dt);
    const seg = sub(next, s.pos);
    const segLen = len(seg);
    const tb = raySphere(s.pos, norm(seg), f.boss.pos, BOSS.radius + SKILLS.beam.radius);
    const tw = raycast(arena, s.pos, next, f.time) * segLen;
    if (tb <= segLen && tb <= tw) {
      events.push({ type: 'beamImpact', pos: add(s.pos, norm(seg), tb), hitBoss: true });
      damageBoss(f, SKILLS.beam.damage, events);
      continue;
    }
    if (tw < segLen || next.y <= heightAt(next.x, next.z)) {
      events.push({ type: 'beamImpact', pos: tw < segLen ? add(s.pos, norm(seg), tw) : next, hitBoss: false });
      continue;
    }
    s.pos = next;
    if (s.ttl > 0) keep.push(s);
  }
  f.shots = keep;
}

// ---------------------------------------------------------------------------------------------
// Rewards (HP-fraction): damage dealt as a share of the player's 150 HP vs damage taken as a
// share of Skynet's 1200, minus a small energy charge. 30 and 240 are both 20% of each side.
// ---------------------------------------------------------------------------------------------

export const REWARD = { dealtScale: 30, takenScale: 240, energyWeight: 0.1, energyScale: 40 };

export function rewardOf(d: Pick<Decision, 'dealt' | 'taken' | 'cost'>): number {
  const r = d.dealt / REWARD.dealtScale - d.taken / REWARD.takenScale - (REWARD.energyWeight * d.cost) / REWARD.energyScale;
  return clamp(r, -1, 1);
}

/**
 * Score decisions whose window has closed and whose projectiles have all resolved.
 * `force` scores everything (fight over).
 */
export function resolveDecisions(f: FightState, force = false): void {
  const live = new Set(f.projectiles.map(p => p.decision));
  f.decisions.forEach((d, i) => {
    if (d.resolved) return;
    if (!force && (d.windowEnd > f.time || live.has(i))) return;
    d.reward = rewardOf(d);
    d.resolved = true;
  });
}

/** Advance the whole fight one tick. Deterministic given the same inputs, seed, and brain. */
export function stepFight(f: FightState, arena: Arena, input: PlayerInput, dt: number, brain: Brain): FightEvent[] {
  const events: FightEvent[] = [];
  const p = f.player;
  const wasDashing = p.dashTimer > 0;
  if (f.outcome === 'active' || f.outcome === 'won') stepPlayer(p, input, dt, arena, f.time);
  // Remember which side the player dodges to, relative to Skynet's line of fire.
  if (!wasDashing && p.dashTimer > 0) {
    const los = sub(p.pos, f.boss.pos);
    const cross = los.x * p.dashDir.z - los.z * p.dashDir.x;
    if (Math.abs(cross) > 1e-3) f.dodgeSide = Math.sign(cross);
  }
  f.hurt = Math.max(0, f.hurt - dt);
  // Armor regenerates slowly once you've gone a while without being hit; health never does.
  f.armorDelay = Math.max(0, f.armorDelay - dt);
  if (f.armorDelay <= 0 && f.outcome === 'active') f.armor = Math.min(VITALS.armor, f.armor + VITALS.armorRegen * dt);
  if (f.outcome === 'active') {
    stepSword(f, events);
    stepSkills(f, arena, input, dt, events);
    stepBoss(f, arena, dt, brain, events);
  }
  stepProjectiles(f, arena, dt, events);
  f.time += dt;
  resolveDecisions(f, f.outcome !== 'active');
  return events;
}

// ---------------------------------------------------------------------------------------------
// Placeholder brain (M3). M4 replaces this with the learned, community-shared policy.
// ---------------------------------------------------------------------------------------------

export function heuristicBrain(f: FightState, arena: Arena, valid: number[]): number {
  const pick = (pred: (a: Arm) => boolean) => {
    const opts = valid.filter(i => pred(ARMS[i]));
    return opts.length ? opts[Math.floor(f.rng() * opts.length)] : -1;
  };
  const isAttack = (id: AttackId) => (a: Arm) => a.kind === 'attack' && a.attack === id;
  const r = f.rng();
  const close = len(sub(playerChest(f.player), f.boss.pos)) < SWEEP.range;
  if (close) {
    const s = pick(isAttack('sweep'));
    if (s >= 0) return s;
  }
  if (f.boss.energy < 40 && r < 0.4) return pick(a => a.kind === 'wait');
  const visible = bossCanSee(f, arena);
  let choice = -1;
  if (visible) {
    if (r < 0.15 && f.player.onGround) choice = pick(isAttack('dive'));
    if (choice < 0) choice = pick(a => a.kind === 'attack' && (a.attack === 'volley' || a.attack === 'spread' || a.attack === 'homing'));
  } else {
    choice = pick(a => a.kind === 'attack' && (a.attack === 'mortar' || a.attack === 'homing'));
  }
  return choice >= 0 ? choice : pick(a => a.kind === 'wait');
}
