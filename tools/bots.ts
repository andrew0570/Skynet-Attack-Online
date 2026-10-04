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
  type Arena,
  type FightState,
  type PlayerInput,
  type Rng,
  type Vec3,
} from '@sao/sim';

export type BotStyle = 'aggressor' | 'kiter' | 'hider' | 'dodger';
export const BOT_STYLES: BotStyle[] = ['aggressor', 'kiter', 'hider', 'dodger'];

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
  /** Hider: where to stand (behind cover) and when to peek out. */
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
    cover: null,
    peekUntil: 0,
    nextPeek: 2 + rng() * 3,
    lastAttack: -1,
  };
  // Start on one of the four cardinal corridors (or the glade for the hider).
  const axis = Math.floor(rng() * 4);
  const ax = [1, -1, 0, 0][axis];
  const az = [0, 0, 1, -1][axis];
  let r = style === 'aggressor' ? 40 + rng() * 25 : 20 + rng() * 15;
  let x = ax * r;
  let z = az * r;
  if (style === 'hider') {
    // Hide behind a glade rubble block, on the side away from the pillar.
    const rubble = arena.statics.filter(s => s.kind === 'rubble');
    const s = rubble[Math.floor(rng() * rubble.length)];
    const d = Math.hypot(s.x, s.z) || 1;
    r = d + Math.max(s.hx, s.hz) + 1.2;
    x = (s.x / d) * r;
    z = (s.z / d) * r;
    bot.cover = { x, y: heightAt(x, z), z };
  }
  f.player.pos = { x, y: heightAt(x, z), z };
  return bot;
}

/** Is something about to hit me? Projectiles on a collision course, mortar rings, sweeps, dives. */
function underThreat(f: FightState): boolean {
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
  return false;
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
  if (react && p.stamina >= STAMINA.dashCost && p.dashCooldown <= 0 && underThreat(f) && bot.rng() < bot.skill) {
    const side = bot.style === 'dodger' ? bot.side : bot.rng() < 0.7 ? bot.side : -bot.side;
    input.moveX = -toBoss.z * side;
    input.moveZ = toBoss.x * side;
    input.dash = true;
    return input;
  }

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

  // Kiter / dodger: hold a mid-range ring around the pillar and strafe; snipe with skills.
  if (t > bot.strafeUntil) {
    bot.strafe = bot.rng() < 0.5 ? 1 : -1;
    bot.strafeUntil = t + 1.5 + bot.rng() * 2;
  }
  const ring = toBoss.dist < 16 ? -1 : toBoss.dist > 30 ? 1 : 0;
  input.moveX = -toBoss.z * bot.strafe + toBoss.x * ring;
  input.moveZ = toBoss.x * bot.strafe + toBoss.z * ring;
  input.sprint = p.stamina > 60 && bot.rng() < 0.02 ? true : p.stamina > 45;
  if (bot.rng() < 0.01 && p.stamina > 40) input.jump = true;
  if (f.skillCd[2] <= 0 && visible) input.skill = 3;
  else if (f.skillCd[0] <= 0 && toBoss.dist < SKILLS.lightning.maxRange) input.skill = 1;
  return input;
}
