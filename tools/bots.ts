// Scripted bot players for training Skynet. They produce the same PlayerInput a human does, so
// they play by exactly the same rules (stamina, cooldowns, collision) in the shared sim.
import {
  ARMS,
  BOSS,
  heightAt,
  NO_INPUT,
  playerChest,
  raycast,
  SKILLS,
  solidTop,
  STAMINA,
  SWORD,
  createPlayer,
  mulberry32,
  SIM_DT,
  stepPlayer,
  type Arena,
  type FightState,
  type Solid,
  type PlayerInput,
  type Rng,
  type Vec3,
} from '@sao/sim';

export type BotStyle = 'aggressor' | 'kiter' | 'hider' | 'dodger' | 'sniper';
export const BOT_STYLES: BotStyle[] = ['aggressor', 'kiter', 'hider', 'dodger', 'sniper'];

export interface Bot {
  style: BotStyle;
  /** Chance to react to a threat with a dodge (0-1). */
  skill: number;
  /** Aim accuracy (0-1): lower = more angular error on beams and lightning, like a human. */
  accuracy: number;
  /** Seconds until the bot next checks for threats (human reaction cadence). */
  nextReact: number;
  /** Preferred dodge side (+1 / -1). The dodger always uses it; others mostly random. */
  side: number;
  rng: Rng;
  /** Kiter/dodger: strafe direction and when to flip it. */
  strafe: number;
  strafeUntil: number;
  /** Kiter: out of breath, walking until stamina recovers. */
  resting: boolean;
  /** Hider: its spot under a roof, and when to peek out. */
  cover: Vec3 | null;
  peekUntil: number;
  nextPeek: number;
  lastAttack: number;
}

const sub = (a: Vec3, b: Vec3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const hdir = (from: Vec3, to: Vec3) => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l, dist: l };
};

/** Create a bot and place the fight's player where that style starts. */
export function createBot(style: BotStyle, f: FightState, arena: Arena, rng: Rng): Bot {
  const bot: Bot = {
    style,
    skill: 0.25 + rng() * 0.6,
    accuracy: 0.25 + rng() * 0.6,
    nextReact: 0,
    side: rng() < 0.5 ? 1 : -1,
    rng,
    strafe: rng() < 0.5 ? 1 : -1,
    strafeUntil: 0,
    resting: false,
    cover: null,
    peekUntil: 0,
    nextPeek: 2 + rng() * 3,
    lastAttack: -1,
  };
  // Start on one of the four cardinal corridors (or the glade for the hider).
  const axis = Math.floor(rng() * 4);
  const ax = [1, -1, 0, 0][axis];
  const az = [0, 0, 1, -1][axis];
  let r = style === 'aggressor' ? 40 + rng() * 25 : style === 'sniper' ? 55 + rng() * 20 : 20 + rng() * 15;
  let x = ax * r;
  let z = az * r;
  if (style === 'hider') {
    // Camp under a fortress roof, out of sight of the perch.
    const spots = coverSpots(arena);
    const s = spots[Math.floor(rng() * spots.length)];
    x = s.x;
    z = s.z;
    bot.cover = { ...s };
  }
  f.player.pos = { x, y: heightAt(x, z), z };
  return bot;
}

/** Ground-level spots under a roof and hidden from Skynet's perch (cached per arena). */
const spotCache = new WeakMap<Arena, Vec3[]>();
function coverSpots(arena: Arena): Vec3[] {
  const hit = spotCache.get(arena);
  if (hit) return hit;
  const rng = mulberry32(99);
  const out: Vec3[] = [];
  for (let i = 0; i < 3000 && out.length < 40; i++) {
    const a = rng() * Math.PI * 2;
    const r = 30 + rng() * 60;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.abs(x) < 9 || Math.abs(z) < 9) continue;
    const y = heightAt(x, z);
    const chest = { x, y: y + 1.2, z };
    if (raycast(arena, chest, { x, y: y + 20, z }, 0) >= 1) continue; // no roof
    if (raycast(arena, arena.skynetAnchor, chest, 0) >= 1) continue; // visible from the perch
    // Must be free standing room (not inside a wall): an idle player stays put on the ground.
    const p = createPlayer(x, z);
    for (let t = 0; t < 30; t++) stepPlayer(p, NO_INPUT, SIM_DT, arena, t * SIM_DT);
    if (Math.hypot(p.pos.x - x, p.pos.z - z) > 0.05 || Math.abs(p.pos.y - y) > 0.05) continue;
    out.push({ x, y, z });
  }
  spotCache.set(arena, out);
  return out;
}

/** Is something about to hit me? Projectiles on a collision course, mortar rings, sweeps, dives. */
function underThreat(f: FightState, arena: Arena): boolean {
  const p = f.player;
  const chest = playerChest(p);
  for (const pr of f.projectiles) {
    if (pr.kind === 'shell' && pr.target) {
      // Shells: will it land on me soon?
      const d = Math.hypot(pr.target.x - p.pos.x, pr.target.z - p.pos.z);
      const fall = pr.vel.y < 0 ? (pr.pos.y - pr.target.y) / Math.max(1, -pr.vel.y) : 9;
      if (d < 5.5 && fall < 0.45) return true;
      continue;
    }
    // Closest approach of the projectile relative to me.
    const rel = sub(pr.pos, chest);
    const rv = sub(pr.vel, p.vel);
    const vv = rv.x * rv.x + rv.y * rv.y + rv.z * rv.z || 1;
    const t = -(rel.x * rv.x + rel.y * rv.y + rel.z * rv.z) / vv;
    if (t < 0 || t > 0.32) continue;
    const miss = len({ x: rel.x + rv.x * t, y: rel.y + rv.y * t, z: rel.z + rv.z * t });
    if (miss < pr.radius + 1.3) return true;
  }
  const b = f.boss;
  const arm = b.arm >= 0 ? ARMS[b.arm] : null;
  if (b.phase === 'telegraph' && arm?.kind === 'attack') {
    if (arm.attack === 'sweep' && len(sub(chest, b.pos)) < 10 && b.timer < 0.2) return true;
    if (arm.attack === 'dive' && Math.hypot(b.aim.x - p.pos.x, b.aim.z - p.pos.z) < 8 && b.timer < 0.25) return true;
  }
  // Sweeping Laser: the beam's heading is closing on mine.
  if (b.phase === 'active' && b.laserDir) {
    const mine = Math.atan2(chest.z - b.pos.z, chest.x - b.pos.x);
    const beam = Math.atan2(b.laserDir.z, b.laserDir.x);
    const gap = Math.atan2(Math.sin(mine - beam), Math.cos(mine - beam));
    if (Math.abs(gap) < 0.22 && raycast(arena, b.pos, chest, f.time) >= 1) return true;
  }
  return false;
}

/**
 * A reactive dodger dashes as soon as a Bolt Volley finishes winding up — which is exactly what
 * a Feint (identical wind-up) exploits. Bots can't tell the two apart, just like a human.
 */
function volleyWindupEnding(f: FightState): boolean {
  const b = f.boss;
  const arm = b.arm >= 0 ? ARMS[b.arm] : null;
  return b.phase === 'telegraph' && arm?.kind === 'attack' && (arm.attack === 'volley' || arm.attack === 'feint') && b.timer < 0.12;
}

/** Aim fields pointing the player (and the "camera" ray) at Skynet, with human aim error. */
function aimAtBoss(f: FightState, bot: Bot): Partial<PlayerInput> {
  const chest = playerChest(f.player);
  const eye = { x: chest.x, y: chest.y + 0.4, z: chest.z };
  const d = sub(f.boss.pos, eye);
  const l = len(d) || 1;
  // Angular error up to ~10° for the worst aimers.
  const err = (1 - bot.accuracy) * 0.18;
  const jx = (bot.rng() * 2 - 1) * err;
  const jy = (bot.rng() * 2 - 1) * err;
  const jz = (bot.rng() * 2 - 1) * err;
  const lx = d.x / l + jx;
  const ly = d.y / l + jy;
  const lz = d.z / l + jz;
  const ll = Math.hypot(lx, ly, lz) || 1;
  const h = hdir(f.player.pos, f.boss.pos);
  return { aimX: h.x, aimZ: h.z, aimPitch: 0, eyeX: eye.x, eyeY: eye.y, eyeZ: eye.z, lookX: lx / ll, lookY: ly / ll, lookZ: lz / ll };
}

export function botInput(bot: Bot, f: FightState, arena: Arena): PlayerInput {
  const p = f.player;
  const b = f.boss;
  const t = f.time;
  const chest = playerChest(p);
  const toBoss = hdir(p.pos, b.pos);
  const bossDist = len(sub(chest, b.pos));
  const visible = raycast(arena, b.pos, chest, t) >= 1;
  const arm = b.arm >= 0 ? ARMS[b.arm] : null;
  const stunned = b.phase === 'recover' && arm?.kind === 'attack' && arm.attack === 'dive';
  const input: PlayerInput = { ...NO_INPUT, ...aimAtBoss(f, bot) };

  // 1) Dodge: dash sideways relative to Skynet's line of fire. Bots only re-check for threats
  // every ~0.15-0.3 s (human reaction), and only dodge with probability `skill`.
  const react = t >= bot.nextReact;
  if (react) bot.nextReact = t + 0.15 + bot.rng() * 0.15;
  const canDash = p.stamina >= STAMINA.dashCost && p.dashCooldown <= 0;
  // The dodger reads wind-ups and dashes pre-emptively; everyone else reacts to what's incoming.
  const preDodge = bot.style === 'dodger' && volleyWindupEnding(f) && bot.rng() < 0.4 + bot.skill * 0.5;
  const dodgeChance = bot.style === 'dodger' ? Math.max(0.8, bot.skill) : bot.skill;
  // Dodgers also juke on their own every couple of seconds when they have stamina to spare.
  const juke = bot.style === 'dodger' && p.stamina > 55 && bot.rng() < 0.008;
  if (canDash && (preDodge || juke || (react && underThreat(f, arena) && bot.rng() < dodgeChance))) {
    const side = bot.style === 'dodger' ? bot.side : bot.rng() < 0.7 ? bot.side : -bot.side;
    input.moveX = -toBoss.z * side;
    input.moveZ = toBoss.x * side;
    input.dash = true;
    return input;
  }

  // Swat a hunter drone that's in sword reach.
  // (Only on a reaction tick, and only as often as the bot's skill: drones are hard to swat.)
  const drone = react && bot.rng() < bot.skill * 0.7 && f.projectiles.find(pr => pr.kind === 'drone' && len(sub(pr.pos, chest)) < SWORD.reach + 0.8);
  if (drone && t - bot.lastAttack > SWORD.swingTime) {
    const d = hdir(p.pos, drone.pos);
    input.aimX = d.x;
    input.aimZ = d.z;
    input.attack = true;
    bot.lastAttack = t;
    return input;
  }

  // Skilled bots hold fire into a Reflect Shield (a lesson the sloppy ones never learn).
  const holdFire = b.shield > 0 && bot.skill > 0.55;

  // 2) Punish a stunned Skynet after a Dive Slam: everyone piles in.
  if (stunned && toBoss.dist < 30) {
    input.moveX = toBoss.x;
    input.moveZ = toBoss.z;
    input.sprint = true;
    if (f.skillCd[1] <= 0 && toBoss.dist < 14) input.skill = 2;
    else if (bossDist < SWORD.reach + BOSS.radius - 0.3 && t - bot.lastAttack > SWORD.swingTime) {
      input.attack = true;
      bot.lastAttack = t;
    }
    return input;
  }

  // 3) Style behaviour.
  const pillar = arena.pillar!;
  const pillarTop = solidTop(pillar);
  const result = styleInput(bot, f, arena, input, { toBoss, bossDist, visible, pillar, pillarTop });
  if (holdFire && result.skill !== 2) {
    result.skill = 0;
    result.attack = false;
  }
  return result;
}

function styleInput(bot: Bot, f: FightState, arena: Arena, input: PlayerInput, ctx: { toBoss: ReturnType<typeof hdir>; bossDist: number; visible: boolean; pillar: Solid; pillarTop: number }): PlayerInput {
  const p = f.player;
  const b = f.boss;
  const t = f.time;
  const { toBoss, bossDist, visible, pillar, pillarTop } = ctx;
  if (bot.style === 'aggressor' && len(sub(b.pos, b.perch)) > 4) {
    // Skynet came off its perch: chase it down and jump to reach it.
    input.moveX = toBoss.x;
    input.moveZ = toBoss.z;
    input.sprint = toBoss.dist > 6 && p.stamina > 30;
    if (toBoss.dist < 8 && b.pos.y - p.pos.y > 3 && p.onGround && p.stamina > 40) input.jump = true;
    if (f.skillCd[1] <= 0 && bossDist < 12) input.skill = 2;
    else if (bossDist < SWORD.reach + BOSS.radius - 0.2 && t - bot.lastAttack > SWORD.swingTime) {
      input.attack = true;
      bot.lastAttack = t;
    } else if (f.skillCd[2] <= 0 && visible) input.skill = 3;
    return input;
  }
  if (bot.style === 'aggressor') {
    const onTop = p.onGround && p.pos.y > pillarTop - 0.3;
    if (onTop) {
      // Stand near the centre of the pillar top and fight Skynet overhead.
      const c = hdir(p.pos, { x: pillar.x, y: 0, z: pillar.z });
      if (c.dist > 0.8) {
        input.moveX = c.x;
        input.moveZ = c.z;
      }
      if (f.skillCd[1] <= 0 && bossDist < 12) input.skill = 2;
      else if (bossDist < SWORD.reach + BOSS.radius - 0.2 && t - bot.lastAttack > SWORD.swingTime) {
        input.attack = true;
        bot.lastAttack = t;
      } else if (f.skillCd[0] <= 0) input.skill = 1;
    } else {
      // Run to the pillar and climb its vines.
      const c = hdir(p.pos, { x: pillar.x, y: 0, z: pillar.z });
      input.moveX = c.x;
      input.moveZ = c.z;
      input.sprint = c.dist > 8 && p.stamina > 30;
      if (f.skillCd[2] <= 0 && visible && bossDist < 60) input.skill = 3;
      else if (f.skillCd[0] <= 0 && toBoss.dist < SKILLS.lightning.maxRange) input.skill = 1;
    }
    return input;
  }

  if (bot.style === 'hider') {
    const home = bot.cover!;
    if (t > bot.nextPeek) {
      bot.peekUntil = t + 0.8 + bot.rng() * 0.8;
      bot.nextPeek = t + 3 + bot.rng() * 4;
    }
    const peeking = t < bot.peekUntil;
    // Peek: step sideways out of cover; otherwise return behind it.
    const goal = peeking ? { x: home.x - toBoss.z * 3 * bot.side, y: 0, z: home.z + toBoss.x * 3 * bot.side } : home;
    const g = hdir(p.pos, goal);
    if (g.dist > 0.6) {
      input.moveX = g.x;
      input.moveZ = g.z;
    }
    if (peeking && visible && f.skillCd[2] <= 0) input.skill = 3;
    else if (f.skillCd[0] <= 0 && toBoss.dist < SKILLS.lightning.maxRange) input.skill = 1;
    return input;
  }

  if (bot.style === 'sniper') {
    // Hold long range (55-75 m), walk (don't sprint) along the ring, and beam on cooldown.
    if (t > bot.strafeUntil) {
      bot.strafe = bot.rng() < 0.5 ? 1 : -1;
      bot.strafeUntil = t + 2 + bot.rng() * 3;
    }
    const ring = toBoss.dist < 55 ? -1 : toBoss.dist > 75 ? 1 : 0;
    // Stay inside the corridor: drift sideways only while near its centre line.
    // (The strafe vector is (-toBoss.z, toBoss.x) · strafe; pick the sign that points back inward.)
    const alongZ = Math.abs(p.pos.x) < Math.abs(p.pos.z);
    const lateral = alongZ ? p.pos.x : p.pos.z;
    if (Math.abs(lateral) > 3.5) bot.strafe = alongZ ? Math.sign(lateral) * Math.sign(toBoss.z || 1) : -Math.sign(lateral) * Math.sign(toBoss.x || 1);
    input.moveX = -toBoss.z * bot.strafe * 0.4 + toBoss.x * ring;
    input.moveZ = toBoss.x * bot.strafe * 0.4 + toBoss.z * ring;
    input.sprint = ring === -1 && p.stamina > 40;
    if (f.skillCd[2] <= 0 && visible) input.skill = 3;
    return input;
  }

  // Kiter / dodger: hold a mid-range ring around the pillar and strafe; snipe with skills.
  if (t > bot.strafeUntil) {
    bot.strafe = bot.rng() < 0.5 ? 1 : -1;
    bot.strafeUntil = t + 1.5 + bot.rng() * 2;
  }
  const ring = toBoss.dist < 16 ? -1 : toBoss.dist > 30 ? 1 : 0;
  input.moveX = -toBoss.z * bot.strafe + toBoss.x * ring;
  input.moveZ = toBoss.x * bot.strafe + toBoss.z * ring;
  // Kiters run flat out (then rest until stamina is back); dodgers save stamina for dashes.
  if (p.stamina < 20) bot.resting = true;
  if (p.stamina > 70) bot.resting = false;
  input.sprint = bot.style === 'kiter' ? !bot.resting : p.stamina > 60;
  if (bot.rng() < 0.01 && p.stamina > 40) input.jump = true;
  if (f.skillCd[2] <= 0 && visible) input.skill = 3;
  else if (f.skillCd[0] <= 0 && toBoss.dist < SKILLS.lightning.maxRange) input.skill = 1;
  return input;
}
