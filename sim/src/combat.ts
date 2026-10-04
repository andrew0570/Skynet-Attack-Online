import { raycast, type Arena } from './arena';
import { ARENA_RADIUS, HURT_INVULN, PLAYER, SKILLS, SWORD, VITALS } from './config';
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
  /** Energy per second. With attack costs of 20-40 this caps sustained attacks at ~1 per 2-3 s. */
  energyRegen: 12,
  /** Minimum pause after every attack before the next decision. */
  globalCooldown: 0.5,
  /** Damage multiplier while stunned on the ground after a Dive Slam. */
  stunnedMultiplier: 1.5,
};

/**
 * How far Skynet's ranged attacks reach: the map's full diameter plus margin for altitude, so
 * there's no safe spot anywhere — even with Skynet flown to the far side of the arena.
 * Projectile lifetimes are derived from it (homing paths curve, so they get 30% extra).
 */
export const BOSS_REACH = 2 * ARENA_RADIUS + 20;
const ttlFor = (speed: number, homing = false) => (BOSS_REACH / speed) * (homing ? 1.3 : 1);

export type AttackId = 'volley' | 'spread' | 'homing' | 'mortar' | 'sweep' | 'dive' | 'reflect' | 'feint' | 'drones' | 'laser';
/** Repositioning moves: Skynet leaves (or returns to) its perch. */
export type MoveId = 'hunt' | 'flank' | 'rise' | 'retreat';
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
  // Style counters:
  /** Shield that reflects sword beams and punishes melee (vs snipers and melee spammers). */
  reflect: { cost: 25, telegraph: 0.25, active: 1.6, recover: 0.3 },
  /** Looks like a volley wind-up, waits for the dodge, then fires fast (vs reactive dodgers). */
  feint: { cost: 24, telegraph: 0.55, active: 0.75, recover: 0.4 },
  /** Slow seekers that phase through walls; destroyable (vs campers). */
  drones: { cost: 30, telegraph: 0.6, active: 0.3, recover: 0.5 },
  /** A beam sweeping an arc across the player; walls block it (vs strafing kiters). */
  laser: { cost: 30, telegraph: 0.7, active: 1.0, recover: 0.5 },
};

export const MOVES = {
  cost: 6,
  speed: 24,
  /** Minimum altitude above the ground: open ground (glade/corridors) vs over the fortresses. */
  minAltOpen: 6,
  minAltFortress: 15,
  /** Hunt: hover this far (horizontally) from the player — inside Blade Sweep range. */
  huntRange: 7,
  /** Flank: look for a sightline from this far away. */
  flankRange: 20,
  rise: 12,
  maxAlt: 45,
};

const PROJ = {
  volley: { speed: 60, damage: 12, radius: 0.35, shots: 5 },
  spread: { speed: 30, damage: 8, radius: 0.35, shots: 7, fan: 0.55 },
  homing: { speed: 13, damage: 18, radius: 0.6, shots: 3, turn: 1.6 },
  /** Lobbed upward at `launchVy` so shells peak high and drop steeply behind cover. */
  mortar: { launchVy: 22, gravity: 24, damage: 22, radius: 0.5, aoe: 4.5, shells: 4, scatter: 3.5 },
};
const SWEEP = { range: 8.5, damage: 25, knockback: 18 };
const DIVE = { aoe: 7, damage: 30, knockback: 16, hoverHeight: 2.2, returnTime: 1.0 };
export const COUNTERS = {
  /** Reflect: beams bounce back for this much; melee into the shield hurts and knocks back. */
  reflectBeamDamage: 30,
  reflectMeleeDamage: 15,
  reflectKnockback: 16,
  /** Feint: silent bait window after the fake wind-up, then fast bolts. */
  feintDelay: 0.35,
  feintShots: 3,
  feintSpeed: 70,
  drone: { count: 2, speed: 11, turn: 2.5, damage: 15, radius: 0.55 },
  laser: { arc: 0.6, range: BOSS_REACH, width: 1.0, damage: 20 },
};

/** One of Skynet's choices. The brain picks an arm index each time Skynet is ready to act. */
export type Arm =
  | { kind: 'wait'; duration: number }
  | { kind: 'attack'; attack: AttackId; aim: AimMode }
  | { kind: 'move'; move: MoveId };

const AIMS: AimMode[] = ['direct', 'lead', 'flank'];
export const ARMS: Arm[] = [
  { kind: 'wait', duration: 0.5 },
  ...(['volley', 'spread', 'homing', 'mortar'] as const).flatMap(attack => AIMS.map(aim => ({ kind: 'attack' as const, attack, aim }))),
  { kind: 'attack', attack: 'sweep', aim: 'direct' },
  { kind: 'attack', attack: 'dive', aim: 'direct' },
  { kind: 'attack', attack: 'dive', aim: 'lead' },
  { kind: 'attack', attack: 'reflect', aim: 'direct' },
  { kind: 'attack', attack: 'feint', aim: 'lead' },
  { kind: 'attack', attack: 'feint', aim: 'flank' },
  { kind: 'attack', attack: 'drones', aim: 'direct' },
  { kind: 'attack', attack: 'laser', aim: 'lead' },
  { kind: 'move', move: 'hunt' },
  { kind: 'move', move: 'flank' },
  { kind: 'move', move: 'rise' },
  { kind: 'move', move: 'retreat' },
];

/** Human-readable name for an arm (HUD, reports). */
export function armLabel(arm: Arm): string {
  if (arm.kind === 'wait') return 'Wait';
  if (arm.kind === 'move') return { hunt: 'Hunt', flank: 'Flank for sight', rise: 'Rise', retreat: 'Retreat to perch' }[arm.move];
  const name = {
    volley: 'Bolt Volley', spread: 'Spread Shot', homing: 'Seeker Orbs', mortar: 'Mortar', sweep: 'Blade Sweep', dive: 'Dive Slam',
    reflect: 'Reflect Shield', feint: 'Feint', drones: 'Hunter Drones', laser: 'Sweeping Laser',
  }[arm.attack];
  return ['reflect', 'drones', 'sweep'].includes(arm.attack) ? name : `${name} (${arm.aim})`;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type BossPhase = 'idle' | 'telegraph' | 'active' | 'recover' | 'return' | 'moving';

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
  /** Where to return to after a Dive Slam (wherever it dove from). */
  home: Vec3;
  /** Flight path while repositioning. */
  moveFrom: Vec3;
  moveTo: Vec3;
  moveTime: number;
  /** Reflect Shield time remaining. */
  shield: number;
  /** Sweeping Laser: centre heading/pitch of the arc and the live beam (for rendering). */
  laserYaw: number;
  laserPitch: number;
  /** Sweep direction (±1) and last tick's heading, for the swept hit test. */
  laserSweep: number;
  laserPrevYaw: number;
  laserDir: Vec3 | null;
  laserLen: number;
  /** Decision index (in fight.decisions) of the current action. */
  decision: number;
}

export type ProjectileKind = 'bolt' | 'orb' | 'shell' | 'drone';

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
  /** Passes through walls (hunter drones). */
  phasing: boolean;
  /** Decision that fired it (credit for M4 rewards). */
  decision: number;
}

/**
 * How the player has been playing, as exponential moving averages (~20 s memory). This is what
 * lets the brain adapt to a *style* rather than only the current moment.
 */
export interface PlayStyle {
  /** Average distance from Skynet (m). */
  dist: number;
  /** Fractions of time: hidden from Skynet, airborne, on the pillar top, moving fast (> 12 m/s). */
  cover: number;
  air: number;
  pillar: number;
  sprint: number;
  /** Rates (per minute): sword swings near Skynet, skills used, dashes. */
  melee: number;
  skills: number;
  dashes: number;
}

export const STYLE_MEMORY = 20;
/** A "neutral" newcomer: also the baseline for explaining which habits drove a choice. */
export const NEUTRAL_STYLE: PlayStyle = { dist: 40, cover: 0.2, air: 0.15, pillar: 0, sprint: 0.3, melee: 0, skills: 2, dashes: 4 };

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
  | { type: 'beamImpact'; pos: Vec3; hitBoss: boolean }
  | { type: 'move'; move: MoveId; to: Vec3 }
  | { type: 'reflected'; pos: Vec3; what: 'beam' | 'melee' | 'lightning' | 'rush' }
  | { type: 'droneDestroyed'; pos: Vec3 };

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
  /** The player's play style so far (rolling averages). */
  style: PlayStyle;
  /** Internal: last seen swing/dash counters and the visibility sample timer. */
  styleTrack: { swings: number; dashing: boolean; losTimer: number; visible: boolean };
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
      home: { ...perch }, moveFrom: { ...perch }, moveTo: { ...perch }, moveTime: 0,
      shield: 0, laserYaw: 0, laserPitch: 0, laserSweep: 1, laserPrevYaw: 0, laserDir: null, laserLen: 0,
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
    style: { ...NEUTRAL_STYLE },
    styleTrack: { swings: 0, dashing: false, losTimer: 0, visible: true },
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
  const horiz = Math.hypot(f.player.pos.x - b.pos.x, f.player.pos.z - b.pos.z);
  const out: number[] = [];
  ARMS.forEach((arm, i) => {
    if (arm.kind === 'wait') return out.push(i);
    if (arm.kind === 'move') {
      if (b.energy < MOVES.cost) return;
      if (arm.move === 'retreat' && len(sub(b.pos, b.perch)) < 3) return;
      if (arm.move === 'hunt' && horiz < MOVES.huntRange + 3) return;
      if (arm.move === 'rise' && b.pos.y - heightAt(b.pos.x, b.pos.z) > MOVES.maxAlt - 2) return;
      return out.push(i);
    }
    if (b.energy < ATTACKS[arm.attack].cost) return;
    if (arm.attack === 'sweep' && toPlayer > SWEEP.range + 1.5) return;
    if (arm.attack === 'dive' && horiz > BOSS_REACH) return;
    out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------------------------

/** Returns true if the hit landed (not dodged / not during post-hit invulnerability). */
function damagePlayer(f: FightState, amount: number, from: Vec3, decision: number, events: FightEvent[], knockback = 0): boolean {
  if (f.outcome !== 'active') return false;
  const p = f.player;
  if (p.invuln > 0 || f.hurt > 0) {
    if (p.invuln > 0) {
      events.push({ type: 'dodged', pos: { ...p.pos } });
      recordDodge(f, true);
    }
    return false;
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
  return true;
}

type DamageSource = 'sword' | 'beam' | 'lightning' | 'rush';

function damageBoss(f: FightState, amount: number, events: FightEvent[], source: DamageSource): void {
  if (f.outcome !== 'active') return;
  const b = f.boss;
  if (b.shield > 0) {
    // Reflect Shield: beams bounce back, melee is punished, lightning is absorbed.
    events.push({ type: 'reflected', pos: { ...b.pos }, what: source === 'sword' ? 'melee' : source });
    if (source === 'beam') damagePlayer(f, COUNTERS.reflectBeamDamage, b.pos, b.decision, events);
    if (source === 'sword' || source === 'rush') {
      const p = f.player;
      p.dashTimer = 0;
      p.rushing = false;
      damagePlayer(f, COUNTERS.reflectMeleeDamage, b.pos, b.decision, events, COUNTERS.reflectKnockback);
    }
    return;
  }
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

function spawn(f: FightState, p: Omit<Projectile, 'id' | 'phasing'> & { phasing?: boolean }): void {
  f.projectiles.push({ ...p, phasing: p.phasing ?? false, id: f.nextId++ });
}

function muzzle(f: FightState, toward: Vec3): Vec3 {
  return add(f.boss.pos, norm(sub(toward, f.boss.pos)), BOSS.radius * 0.7);
}

/** Keep a hover point inside the arena rim. */
function clampToArena(x: number, z: number): { x: number; z: number } {
  const r = Math.hypot(x, z);
  const max = 88;
  return r > max ? { x: (x / r) * max, z: (z / r) * max } : { x, z };
}

/** Lowest safe hover height at (x, z): clear of fortress roofs, higher over them. */
function hoverFloor(f: FightState, arena: Arena, x: number, z: number): number {
  const ground = heightAt(x, z);
  const top = ground + 70;
  const t = raycast(arena, { x, y: top, z }, { x, y: ground, z }, f.time);
  if (t >= 1) return ground + MOVES.minAltOpen;
  return Math.max(ground + MOVES.minAltFortress, top + (ground - top) * t + 5);
}

/** Where a repositioning move takes Skynet. */
function moveTarget(f: FightState, arena: Arena, move: MoveId): Vec3 {
  const b = f.boss;
  const p = f.player.pos;
  const chest = playerChest(f.player);
  if (move === 'retreat') return { ...b.perch };
  if (move === 'rise') return { x: b.pos.x, y: Math.min(b.pos.y + MOVES.rise, heightAt(b.pos.x, b.pos.z) + MOVES.maxAlt), z: b.pos.z };
  if (move === 'hunt') {
    // Close in to just outside sword reach, on the side Skynet is already on.
    const dx = b.pos.x - p.x;
    const dz = b.pos.z - p.z;
    const h = Math.hypot(dx, dz) || 1;
    const c = clampToArena(p.x + (dx / h) * MOVES.huntRange, p.z + (dz / h) * MOVES.huntRange);
    return { x: c.x, y: Math.max(p.y + 4, hoverFloor(f, arena, c.x, c.z)), z: c.z };
  }
  // Flank: the nearest point on a ring around the player with a clear shot.
  const base = Math.atan2(b.pos.z - p.z, b.pos.x - p.x);
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let i = 0; i < 12; i++) {
    const a = base + (i / 12) * Math.PI * 2;
    const c = clampToArena(p.x + Math.cos(a) * MOVES.flankRange, p.z + Math.sin(a) * MOVES.flankRange);
    const q = { x: c.x, y: Math.max(p.y + 8, hoverFloor(f, arena, c.x, c.z)), z: c.z };
    if (raycast(arena, q, chest, f.time) < 1) continue;
    const d = len(sub(q, b.pos));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best ?? { x: p.x, y: Math.max(p.y + 20, hoverFloor(f, arena, p.x, p.z)), z: p.z };
}

function startAction(f: FightState, arena: Arena, armIndex: number, context: number[], events: FightEvent[]): void {
  const b = f.boss;
  const arm = ARMS[armIndex];
  b.arm = armIndex;
  // The previous decision's damage-taken window closes now.
  if (f.decisions.length) f.decisions[f.decisions.length - 1].windowEnd = f.time;
  const cost = arm.kind === 'attack' ? ATTACKS[arm.attack].cost : arm.kind === 'move' ? MOVES.cost : 0;
  f.decisions.push({ time: f.time, arm: armIndex, context, cost, dealt: 0, taken: 0, windowEnd: Infinity, resolved: false, reward: 0 });
  b.decision = f.decisions.length - 1;
  if (arm.kind === 'wait') {
    b.cooldown = arm.duration;
    return;
  }
  if (arm.kind === 'move') {
    b.energy -= MOVES.cost;
    const to = moveTarget(f, arena, arm.move);
    b.moveFrom = { ...b.pos };
    b.moveTo = to;
    b.moveTime = clamp(len(sub(to, b.pos)) / MOVES.speed, 0.35, 2);
    b.timer = b.moveTime;
    b.phase = 'moving';
    events.push({ type: 'move', move: arm.move, to: { ...to } });
    return;
  }
  const spec = ATTACKS[arm.attack];
  b.energy -= spec.cost;
  b.phase = 'telegraph';
  b.timer = spec.telegraph;
  b.shotsFired = 0;
  const speedOf: Partial<Record<AttackId, number>> = { volley: PROJ.volley.speed, spread: PROJ.spread.speed, homing: PROJ.homing.speed, feint: COUNTERS.feintSpeed, drones: COUNTERS.drone.speed };
  const speed = speedOf[arm.attack] ?? 0;
  const t = speed
    ? flightTimeTo(f, speed) + spec.telegraph
    : arm.attack === 'mortar'
      ? mortarFlightTime(b.pos.y - f.player.pos.y) + spec.telegraph
      : spec.telegraph + spec.active * 0.5;
  b.aim = aimPoint(f, arm.aim, t);
  const markers: Vec3[] = [];
  if (arm.attack === 'dive') {
    b.aim = { x: b.aim.x, y: heightAt(b.aim.x, b.aim.z), z: b.aim.z };
    markers.push(b.aim);
  }
  if (arm.attack === 'laser') {
    // Centre the arc on where the player is heading; start on the side they're running toward
    // and sweep back across them.
    const d = sub(b.aim, b.pos);
    b.laserYaw = Math.atan2(d.z, d.x);
    // Pitch locks onto waist height at the predicted range: the beam rakes a line across the
    // ground there. Changing range (or jumping) slips under/over it; strafing sideways doesn't.
    const waist = heightAt(b.aim.x, b.aim.z) + 1;
    b.laserPitch = Math.atan2(waist - b.pos.y, Math.max(Math.hypot(d.x, d.z), 1));
    const v = f.player.vel;
    const turning = d.x * v.z - d.z * v.x;
    b.laserSweep = Math.abs(turning) > 1e-3 ? Math.sign(turning) : f.rng() < 0.5 ? -1 : 1;
    b.laserPrevYaw = b.laserYaw + COUNTERS.laser.arc * b.laserSweep;
    b.laserDir = null;
  }
  // A Feint winds up exactly like a Bolt Volley — that's the point.
  events.push({ type: 'telegraph', attack: arm.attack === 'feint' ? 'volley' : arm.attack, aim: { ...b.aim }, markers });
}

/** Sweeping Laser direction for a heading and pitch. */
function laserDirection(yaw: number, pitch: number): Vec3 {
  return { x: Math.cos(pitch) * Math.cos(yaw), y: Math.sin(pitch), z: Math.cos(pitch) * Math.sin(yaw) };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

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
        spawn(f, { kind: 'bolt', pos: from, vel: add(vec3(), norm(sub(target, from)), PROJ.volley.speed), ttl: ttlFor(PROJ.volley.speed), damage: PROJ.volley.damage, radius: PROJ.volley.radius, aoe: 0, gravity: 0, homing: 0, target: null, decision: b.decision });
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
        spawn(f, { kind: 'bolt', pos: from, vel: add(vec3(), v, PROJ.spread.speed), ttl: ttlFor(PROJ.spread.speed), damage: PROJ.spread.damage, radius: PROJ.spread.radius, aoe: 0, gravity: 0, homing: 0, target: null, decision: b.decision });
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
        spawn(f, { kind: 'orb', pos: from, vel: add(vec3(), v, PROJ.homing.speed), ttl: ttlFor(PROJ.homing.speed, true), damage: PROJ.homing.damage, radius: PROJ.homing.radius, aoe: 0, gravity: 0, homing: PROJ.homing.turn, target: null, decision: b.decision });
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
    case 'reflect': {
      if (b.shotsFired) break;
      b.shotsFired = 1;
      b.shield = spec.active;
      events.push({ type: 'fire', attack: 'reflect' });
      break;
    }
    case 'feint': {
      // Silent bait window (the dodge goes out), then fast bolts at where they dodged to.
      if (elapsed < COUNTERS.feintDelay) break;
      const due = Math.min(COUNTERS.feintShots, Math.floor((elapsed - COUNTERS.feintDelay) / 0.08) + 1);
      while (b.shotsFired < due) {
        const target = aimPoint(f, arm.aim, flightTimeTo(f, COUNTERS.feintSpeed));
        const from = muzzle(f, target);
        spawn(f, { kind: 'bolt', pos: from, vel: add(vec3(), norm(sub(target, from)), COUNTERS.feintSpeed), ttl: ttlFor(COUNTERS.feintSpeed), damage: PROJ.volley.damage, radius: PROJ.volley.radius, aoe: 0, gravity: 0, homing: 0, target: null, decision: b.decision });
        b.shotsFired++;
        if (b.shotsFired === 1) events.push({ type: 'fire', attack: 'feint' });
      }
      break;
    }
    case 'drones': {
      if (b.shotsFired) break;
      const D = COUNTERS.drone;
      const chest = playerChest(f.player);
      for (let i = 0; i < D.count; i++) {
        // Launch up and out to either side; they curve in (through walls) from there.
        const side = i % 2 ? 1 : -1;
        const d = norm(sub(chest, b.pos));
        const v = norm({ x: d.x - d.z * side * 1.2, y: 0.8, z: d.z + d.x * side * 1.2 });
        spawn(f, { kind: 'drone', pos: muzzle(f, add(b.pos, v)), vel: add(vec3(), v, D.speed), ttl: ttlFor(D.speed, true), damage: D.damage, radius: D.radius, aoe: 0, gravity: 0, homing: D.turn, target: null, phasing: true, decision: b.decision });
      }
      b.shotsFired = D.count;
      events.push({ type: 'fire', attack: 'drones' });
      break;
    }
    case 'laser': {
      const L = COUNTERS.laser;
      const k = clamp(elapsed / spec.active, 0, 1);
      const yaw = b.laserYaw + L.arc * b.laserSweep * (1 - 2 * k);
      const p = f.player;
      const d = sub(p.pos, b.pos);
      const h = Math.hypot(d.x, d.z);
      const dir = laserDirection(yaw, b.laserPitch);
      if (!b.laserDir) events.push({ type: 'fire', attack: 'laser' });
      b.laserDir = dir;
      // Beam length: stopped by walls/roofs and the ground.
      const end = add(b.pos, dir, L.range);
      let length = raycast(arena, b.pos, end, f.time) * L.range;
      for (let s = 2; s < length; s += 2) {
        const q = add(b.pos, dir, s);
        if (q.y <= heightAt(q.x, q.z)) {
          length = s;
          break;
        }
      }
      b.laserLen = length;
      // Did the beam pass over the player since last tick? (swept test, so fast sweeps can't skip)
      // Beam height where the player stands; it must cross their body.
      const beamY = b.pos.y + Math.tan(b.laserPitch) * h;
      const onBody = beamY >= p.pos.y - 0.3 && beamY <= p.pos.y + PLAYER.height + 0.3;
      if (!b.shotsFired && onBody && h * Math.hypot(1, Math.tan(b.laserPitch)) <= length + 1) {
        const tol = (L.width + 0.45) / Math.max(h, 1);
        const rel = wrapAngle(Math.atan2(d.z, d.x) - yaw);
        const prevRel = wrapAngle(b.laserPrevYaw - yaw);
        const lo = Math.min(0, prevRel) - tol;
        const hi = Math.max(0, prevRel) + tol;
        if (rel >= lo && rel <= hi && raycast(arena, b.pos, { x: p.pos.x, y: beamY, z: p.pos.z }, f.time) >= 1) {
          b.shotsFired = 1;
          damagePlayer(f, L.damage, b.pos, b.decision, events);
        }
      }
      b.laserPrevYaw = yaw;
      break;
    }
  }
}

function stepBoss(f: FightState, arena: Arena, dt: number, brain: Brain, events: FightEvent[]): void {
  const b = f.boss;
  b.energy = Math.min(BOSS.maxEnergy, b.energy + BOSS.energyRegen * dt);
  b.cooldown = Math.max(0, b.cooldown - dt);
  b.shield = Math.max(0, b.shield - dt);

  switch (b.phase) {
    case 'idle':
      if (b.cooldown <= 0 && f.outcome === 'active') {
        const context = contextOf(f, arena);
        const valid = validArms(f);
        let arm = brain(f, arena, valid, context);
        if (!valid.includes(arm)) arm = valid[0]; // never let a brain pick an invalid arm
        startAction(f, arena, arm, context, events);
      }
      break;
    case 'moving': {
      b.timer -= dt;
      const k = 1 - Math.max(0, b.timer) / b.moveTime;
      const e = k * k * (3 - 2 * k);
      b.pos = add(b.moveFrom, sub(b.moveTo, b.moveFrom), e);
      if (b.timer <= 0) {
        b.pos = { ...b.moveTo };
        b.phase = 'idle';
        b.cooldown = 0.15;
      }
      break;
    }
    case 'telegraph':
      b.timer -= dt;
      if (b.timer <= 0) {
        const arm = ARMS[b.arm] as { attack: AttackId };
        b.phase = 'active';
        b.timer = ATTACKS[arm.attack].active;
        b.diveFrom = { ...b.pos };
        if (arm.attack === 'dive') b.home = { ...b.pos };
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
        b.laserDir = null;
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
      b.pos = add(b.diveFrom, sub(b.home, b.diveFrom), e);
      if (b.timer <= 0) {
        b.pos = { ...b.home };
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
    // World hit: walls/roofs block projectiles (that's what makes cover work) — except drones.
    const t = pr.phasing ? 1 : raycast(arena, pr.pos, next, f.time);
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
  // In the arc, within `reach` (plus the target's radius)?
  const inArc = (q: Vec3, radius: number) => {
    const d = sub(q, chest);
    if (len(d) > SWORD.reach + radius) return false;
    if (Math.hypot(d.x, d.z) <= 2) return true;
    return Math.abs(wrapAngle(Math.atan2(d.x, d.z) - p.yaw)) <= SWORD.arcHalf;
  };
  // Hunter drones can be cut down.
  f.projectiles = f.projectiles.filter(pr => {
    if (pr.kind !== 'drone' || !inArc(pr.pos, pr.radius + 0.6)) return true;
    events.push({ type: 'droneDestroyed', pos: { ...pr.pos } });
    return false;
  });
  if (inArc(f.boss.pos, BOSS.radius)) damageBoss(f, SWORD.damage[p.comboStep], events, 'sword');
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
  if (hit) damageBoss(f, L.damage, events, 'lightning');
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
      damageBoss(f, SKILLS.rush.damage, events, 'rush');
      f.rushHits++;
      f.rushHitTimer = SKILLS.rush.hitInterval;
    }
  }

  // Sword beams: hit a drone, Skynet (segment vs sphere), walls, or terrain.
  const keep: PlayerShot[] = [];
  for (const s of f.shots) {
    s.ttl -= dt;
    const next = add(s.pos, s.vel, dt);
    const seg = sub(next, s.pos);
    const segLen = len(seg);
    const tw = raycast(arena, s.pos, next, f.time) * segLen;
    const drone = f.projectiles.find(pr => pr.kind === 'drone' && raySphere(s.pos, norm(seg), pr.pos, pr.radius + SKILLS.beam.radius + 0.4) <= Math.min(segLen, tw));
    if (drone) {
      f.projectiles = f.projectiles.filter(pr => pr !== drone);
      events.push({ type: 'droneDestroyed', pos: { ...drone.pos } });
      events.push({ type: 'beamImpact', pos: { ...drone.pos }, hitBoss: false });
      continue;
    }
    const tb = raySphere(s.pos, norm(seg), f.boss.pos, BOSS.radius + SKILLS.beam.radius);
    if (tb <= segLen && tb <= tw) {
      events.push({ type: 'beamImpact', pos: add(s.pos, norm(seg), tb), hitBoss: true });
      damageBoss(f, SKILLS.beam.damage, events, 'beam');
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

/**
 * `moveCredit`: a repositioning move deals no damage itself — its value is the attack it sets up,
 * so it also earns this share of the next decision's reward.
 */
export const REWARD = { dealtScale: 30, takenScale: 240, energyWeight: 0.1, energyScale: 40, moveCredit: 0.6 };

export function rewardOf(d: Pick<Decision, 'dealt' | 'taken' | 'cost'>): number {
  const r = d.dealt / REWARD.dealtScale - d.taken / REWARD.takenScale - (REWARD.energyWeight * d.cost) / REWARD.energyScale;
  return clamp(r, -1, 1);
}

/**
 * Score decisions whose window has closed and whose projectiles have all resolved.
 * `force` scores everything (fight over). Moves wait for the decision after them.
 */
export function resolveDecisions(f: FightState, force = false): void {
  const live = new Set(f.projectiles.map(p => p.decision));
  // Newest first, so a move sees its follow-up's reward in the same pass.
  for (let i = f.decisions.length - 1; i >= 0; i--) {
    const d = f.decisions[i];
    if (d.resolved) continue;
    if (!force && (d.windowEnd > f.time || live.has(i))) continue;
    const next = f.decisions[i + 1];
    if (ARMS[d.arm].kind === 'move') {
      if (!force && !next?.resolved) continue;
      d.reward = clamp(rewardOf(d) + REWARD.moveCredit * (next ? rewardOf(next) : 0), -1, 1);
    } else d.reward = rewardOf(d);
    d.resolved = true;
  }
}

/** Update the rolling play-style profile (what the brain reads as "how this player plays"). */
function updateStyle(f: FightState, arena: Arena, input: PlayerInput, dt: number, swung: boolean, usedSkill: boolean, dashed: boolean): void {
  const p = f.player;
  const s = f.style;
  const tr = f.styleTrack;
  const k = 1 - Math.exp(-dt / STYLE_MEMORY);
  const decay = Math.exp(-dt / STYLE_MEMORY);
  const ema = (v: number, x: number) => v + (x - v) * k;
  // Event rates in per-minute units: each event adds 60/τ, decaying with time constant τ.
  const rate = (v: number, happened: boolean) => v * decay + (happened ? 60 / STYLE_MEMORY : 0);
  tr.losTimer -= dt;
  if (tr.losTimer <= 0) {
    tr.losTimer = 0.2;
    tr.visible = bossCanSee(f, arena);
  }
  const dist = len(sub(playerChest(p), f.boss.pos));
  const pil = arena.pillar;
  const onPillar = !!pil && Math.hypot(p.pos.x - pil.x, p.pos.z - pil.z) <= pil.r + 1.5 && p.pos.y >= pil.y + pil.height - 1.5;
  s.dist = ema(s.dist, dist);
  s.cover = ema(s.cover, tr.visible ? 0 : 1);
  s.air = ema(s.air, !p.onGround && !p.climbing ? 1 : 0);
  s.pillar = ema(s.pillar, onPillar ? 1 : 0);
  s.sprint = ema(s.sprint, Math.hypot(p.vel.x, p.vel.z) > 12 ? 1 : 0);
  s.melee = rate(s.melee, swung && dist < 15);
  s.skills = rate(s.skills, usedSkill);
  s.dashes = rate(s.dashes, dashed);
}

/** Advance the whole fight one tick. Deterministic given the same inputs, seed, and brain. */
export function stepFight(f: FightState, arena: Arena, input: PlayerInput, dt: number, brain: Brain): FightEvent[] {
  const events: FightEvent[] = [];
  const p = f.player;
  const wasDashing = p.dashTimer > 0;
  const prevSwing = p.swingTimer;
  const prevCd = f.skillCd.slice();
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
    const usedSkill = f.skillCd.some((c, i) => c > prevCd[i]);
    updateStyle(f, arena, input, dt, p.swingTimer > prevSwing, usedSkill, !wasDashing && p.dashTimer > 0 && !p.rushing);
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
  const isAttack = (...ids: AttackId[]) => (a: Arm) => a.kind === 'attack' && ids.includes(a.attack);
  const isMove = (m: MoveId) => (a: Arm) => a.kind === 'move' && a.move === m;
  const r = f.rng();
  const close = len(sub(playerChest(f.player), f.boss.pos)) < SWEEP.range;
  if (close) {
    const s = pick(isAttack(r < 0.5 ? 'sweep' : 'reflect'));
    if (s >= 0) return s;
  }
  if (f.boss.energy < 40 && r < 0.4) return pick(a => a.kind === 'wait');
  const visible = bossCanSee(f, arena);
  let choice = -1;
  if (visible) {
    if (r < 0.15 && f.player.onGround) choice = pick(isAttack('dive'));
    if (choice < 0) choice = pick(isAttack('volley', 'spread', 'homing', 'feint', 'laser'));
  } else {
    if (r < 0.3) choice = pick(isMove('flank'));
    if (choice < 0) choice = pick(isAttack('mortar', 'homing', 'drones'));
  }
  if (choice < 0 && len(sub(f.boss.pos, f.boss.perch)) > 30 && r < 0.5) choice = pick(isMove('retreat'));
  return choice >= 0 ? choice : pick(a => a.kind === 'wait');
}
