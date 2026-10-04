import { raycast, type Arena } from './arena';
import { botInput, createBot, type Bot, type BotStyle } from './bots';
import {
  BOSS,
  createFight,
  createSlot,
  hitBoss,
  loadSlot,
  playerChest,
  saveSlot,
  stepBossSide,
  stepPlayerSide,
  stepProjectiles,
  STYLE_MEMORY,
  type Brain,
  type DamageSource,
  type FightEvent,
  type FightState,
  type PlayerSlot,
} from './combat';
import { ARENA_RADIUS, SKILLS, SWORD } from './config';
import { NO_INPUT, type PlayerState } from './player';
import { mulberry32 } from './rng';
import { heightAt } from './terrain';

// =============================================================================================
// Co-op raid: up to 5 members (humans + server-run bots) against one Skynet. Runs inside the
// SpacetimeDB module (a scheduled reducer steps it ~20×/s) on the same rules as solo, by
// loading each member's slot into a FightState in turn. Humans own their movement (their client
// streams it in); everything else — Skynet, its projectiles, damage, bots — is server-side.
// =============================================================================================

export const RAID = {
  size: 5,
  /** Skynet's HP grows with the team: +60% per extra member. */
  hpPerMember: 0.6,
  /** Seconds between target re-evaluations. */
  retarget: 3,
  /** Server ticks per second (each runs SIM_STEPS sim steps of 1/60 s). */
  tickRate: 20,
  simSteps: 3,
  /** Hit reports: largest single hit per source, and a damage-per-second budget per member. */
  maxHit: { sword: 66, beam: 60, lightning: 120, rush: 18 } as Record<DamageSource, number>,
  dpsBudget: 160,
  burst: 240,
};

export interface RaidMember {
  /** Stable index within this raid (also the bot RNG stream). */
  id: number;
  bot: Bot | null;
  slot: PlayerSlot;
  dead: boolean;
  /** Damage dealt to Skynet (scoreboard). */
  dealt: number;
  /** Remaining hit-report budget (humans). */
  budget: number;
}

export interface RaidSim {
  seed: number;
  ticks: number;
  fight: FightState;
  members: RaidMember[];
  /** Member id Skynet is currently focused on. */
  target: number;
  retargetIn: number;
}

/** Start a raid. `roster`: one entry per member, a bot style for bots, null for humans. */
export function createRaid(arena: Arena, roster: (BotStyle | null)[], seed: number): RaidSim {
  const f = createFight(arena, seed);
  const maxHp = Math.round(BOSS.maxHp * (1 + RAID.hpPerMember * (roster.length - 1)));
  f.boss.hp = f.boss.maxHp = maxHp;
  const members = roster.map((style, id) => {
    // Humans spawn side by side at the usual spawn; bots go wherever their style starts.
    const slot = createSlot(arena.spawn.x + (id - 2) * 3, arena.spawn.z);
    let bot: Bot | null = null;
    if (style) {
      loadSlot(f, slot);
      bot = createBot(style, f, arena, mulberry32(seed * 31 + id));
      saveSlot(f, slot);
    }
    return { id, bot, slot, dead: false, dealt: 0, budget: RAID.burst };
  });
  return { seed, ticks: 0, fight: f, members, target: 0, retargetIn: 0 };
}

const alive = (r: RaidSim) => r.members.filter(m => !m.dead);

/** Skynet focuses the nearest member it can see (else the nearest), re-checked every few seconds. */
function pickTarget(r: RaidSim, arena: Arena): void {
  const b = r.fight.boss.pos;
  let best = -1;
  let bestScore = Infinity;
  for (const m of alive(r)) {
    const chest = playerChest(m.slot.player);
    const d = Math.hypot(chest.x - b.x, chest.y - b.y, chest.z - b.z);
    const seen = raycast(arena, b, chest, r.fight.time) >= 1;
    const score = d - (seen ? 40 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = m.id;
    }
  }
  if (best >= 0) r.target = best;
}

/** A member died if a hit took their health to 0; single-player rules end the fight there — not in a raid. */
function settleDeaths(r: RaidSim, events: FightEvent[]): void {
  const f = r.fight;
  for (const m of r.members) if (!m.dead && m.slot.health <= 0) m.dead = true;
  if (f.outcome === 'lost') f.outcome = 'active';
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'lost') events.splice(i, 1);
  if (f.outcome === 'active' && alive(r).length === 0) {
    f.outcome = 'lost';
    events.push({ type: 'lost' });
  }
}

/** Advance the raid one sim step (1/60 s). */
export function stepRaid(r: RaidSim, arena: Arena, dt: number, brain: Brain): FightEvent[] {
  const f = r.fight;
  const events: FightEvent[] = [];
  if (f.outcome !== 'active') {
    f.time += dt;
    return events;
  }
  // Members: bots think and act; humans only tick their vitals and habits (their client moves them).
  for (const m of r.members) {
    if (m.dead) continue;
    loadSlot(f, m.slot);
    const before = events.length;
    if (m.bot) stepPlayerSide(f, arena, botInput(m.bot, f, arena), dt, events);
    else {
      stepPlayerSide(f, arena, NO_INPUT, dt, events, false);
      m.budget = Math.min(RAID.burst, m.budget + RAID.dpsBudget * dt);
    }
    for (let i = before; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'bossHit') m.dealt += e.damage;
    }
    saveSlot(f, m.slot);
    settleDeaths(r, events);
    if (f.outcome !== 'active') break;
  }
  if (f.outcome === 'active') {
    // Skynet acts against its current target; its projectiles can hit anyone.
    r.retargetIn -= dt;
    const target = r.members.find(m => m.id === r.target);
    if (!target || target.dead || r.retargetIn <= 0) {
      pickTarget(r, arena);
      r.retargetIn = RAID.retarget;
    }
    const t = r.members.find(m => m.id === r.target)!;
    loadSlot(f, t.slot);
    stepBossSide(f, arena, dt, brain, events);
    saveSlot(f, t.slot);
    settleDeaths(r, events);
    loadSlot(f, t.slot);
    stepProjectiles(f, arena, dt, events, alive(r).map(m => m.slot));
    settleDeaths(r, events);
  }
  f.time += dt;
  r.ticks++;
  return events;
}

/** Fields a client may set on its own member (its movement and animation state). */
const CLIENT_FIELDS: (keyof PlayerState)[] = [
  'pos', 'vel', 'yaw', 'onGround', 'invuln', 'dashTimer', 'dashDir', 'climbing', 'gliding', 'airJumpCount', 'swingTimer', 'comboStep', 'rushing', 'stamina',
];

/** A human member's client streamed its movement. Also feeds their habit profile (swings, dashes, skills). */
export function applyMemberState(r: RaidSim, id: number, state: Partial<PlayerState>, skillsUsed: number): void {
  const m = r.members.find(x => x.id === id);
  if (!m || m.bot || m.dead) return;
  const p = m.slot.player;
  const swung = (state.swingTimer ?? 0) > p.swingTimer + 1e-6;
  const dashed = (state.dashTimer ?? 0) > 0 && p.dashTimer <= 0 && !state.rushing;
  for (const k of CLIENT_FIELDS) {
    const v = state[k];
    if (v === undefined) continue;
    (p as unknown as Record<string, unknown>)[k] = typeof v === 'object' ? { ...(v as object) } : v;
  }
  // Keep the reported position inside the arena (no hiding outside the walls).
  const rr = Math.hypot(p.pos.x, p.pos.z);
  if (!Number.isFinite(rr) || rr > ARENA_RADIUS) p.pos = { x: 0, y: heightAt(0, 30), z: 30 };
  const s = m.slot.style;
  const bump = 60 / STYLE_MEMORY;
  const near = Math.hypot(p.pos.x - r.fight.boss.pos.x, p.pos.y - r.fight.boss.pos.y, p.pos.z - r.fight.boss.pos.z) < 15;
  if (swung && near) s.melee += bump;
  if (dashed) s.dashes += bump;
  s.skills += bump * Math.max(0, Math.min(3, skillsUsed));
}

/**
 * A human member's client reports a hit on Skynet (base damage, before Skynet's stun bonus).
 * Validated: alive, a plausible amount for the source and range, and within a damage budget.
 * Goes through the normal rules, so a Reflect Shield bounces it back at the attacker.
 */
export function applyMemberHit(r: RaidSim, id: number, amount: number, source: DamageSource): FightEvent[] {
  const events: FightEvent[] = [];
  const m = r.members.find(x => x.id === id);
  const f = r.fight;
  if (!m || m.bot || m.dead || f.outcome !== 'active') return events;
  if (!(amount > 0) || amount > RAID.maxHit[source] || amount > m.budget) return events;
  const chest = playerChest(m.slot.player);
  const d = Math.hypot(chest.x - f.boss.pos.x, chest.y - f.boss.pos.y, chest.z - f.boss.pos.z);
  const reach = source === 'sword' ? SWORD.reach + BOSS.radius + 4 : source === 'rush' ? SKILLS.rush.reach + BOSS.radius + 6 : source === 'beam' ? SKILLS.beam.speed * SKILLS.beam.ttl + 10 : SKILLS.lightning.maxRange + 60;
  if (d > reach) return events;
  m.budget -= amount;
  loadSlot(f, m.slot);
  hitBoss(f, amount, events, source);
  for (const e of events) if (e.type === 'bossHit') m.dealt += e.damage;
  saveSlot(f, m.slot);
  settleDeaths(r, events);
  return events;
}

/** Serialize for storage (RNGs are recreated from the seed and tick count on load). */
export function raidToJson(r: RaidSim): string {
  // Decisions only matter for training, which raids don't do; keep the stored state small.
  r.fight.decisions = [];
  r.fight.boss.decision = -1;
  for (const p of r.fight.projectiles) p.decision = -1;
  return JSON.stringify(r);
}

export function raidFromJson(json: string): RaidSim {
  const r = JSON.parse(json) as RaidSim;
  r.fight.rng = mulberry32((r.seed * 7919 + r.ticks) >>> 0);
  for (const m of r.members) if (m.bot) m.bot.rng = mulberry32((r.seed * 104729 + m.id * 7 + r.ticks) >>> 0);
  return r;
}
