import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import {
  applyMemberHit,
  applyMemberState,
  ARMS,
  createRaid,
  generateArena,
  learnedBrain,
  RAID,
  raidFromJson,
  raidToJson,
  SIM_DT,
  stepRaid,
  type BotStyle,
  type DamageSource,
  type FightEvent,
  createArmModel,
  FEATURE_DIM,
  SUBMIT_LIMITS,
  trainOn,
  validateSubmission,
  type ArmModel,
  type FightSubmission,
  type Policy,
} from '@sao/sim';

// Skynet's shared brain lives here. Clients choose with the weights (frozen per fight); only
// this module learns, and only from fights that pass validation.

const SNAPSHOT_EVERY = 10;

/** Drives the raid tick: one repeating row (RAID.tickRate per second). */
const raidTickTable = table(
  { name: 'raid_tick' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  player: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      consented: t.bool(),
      joinedAt: t.timestamp(),
      /** Microseconds since epoch of the last accepted submission (rate limit). */
      lastSubmitMicros: t.u64(),
    }
  ),
  /** Single row (id 0): the shared brain's version and lifetime stats. */
  policyMeta: table(
    { public: true },
    {
      id: t.u32().primaryKey(),
      version: t.u32(),
      fights: t.u32(),
      decisions: t.u32(),
      rejected: t.u32(),
      wins: t.u32(),
      losses: t.u32(),
    }
  ),
  /** One LinUCB model per arm. Clients need ainv + theta to score; a + b are the learning state. */
  policyArm: table(
    { public: true },
    {
      arm: t.u32().primaryKey(),
      a: t.array(t.f64()),
      b: t.array(t.f64()),
      ainv: t.array(t.f64()),
      theta: t.array(t.f64()),
      n: t.u32(),
      rewardSum: t.f64(),
    }
  ),
  /** Every submitted fight, accepted or not (rejections keep their reason). */
  fight: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      player: t.identity(),
      at: t.timestamp(),
      outcome: t.string(),
      duration: t.f64(),
      decisions: t.u32(),
      dealt: t.f64(),
      taken: t.f64(),
      meanReward: t.f64(),
      policyVersion: t.u32(),
      accepted: t.bool(),
      reason: t.string(),
    }
  ),
  /**
   * Co-op raids. The server owns the fight: a scheduled reducer steps Skynet, its projectiles,
   * damage, and the bots ~20×/s with the same sim code as solo play. `sim` is the full raid
   * state (clients read Skynet and its projectiles from it); `events` are the latest tick's
   * effects (telegraphs, impacts, hits) for the clients' VFX.
   */
  raid: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      /** lobby | active | won | lost */
      status: t.string(),
      createdAt: t.timestamp(),
      endedAtMicros: t.u64(),
      tick: t.u32(),
      bossHp: t.f64(),
      bossMaxHp: t.f64(),
      policyVersion: t.u32(),
      sim: t.string(),
      events: t.string(),
    }
  ),
  /**
   * One row per raid member. Humans stream `state` (their movement/animation) and queue hit
   * reports in `hits`; the tick applies both. Bots' `state` is written by the tick. Callsign and
   * color live here only while the member is in the raid (rows are deleted when they leave).
   */
  raidMember: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      raidId: t.u64().index('btree'),
      /** Identity hex of the human ('' for bots). */
      owner: t.string(),
      /** Member index inside the raid sim (assigned at start). */
      slot: t.u32(),
      name: t.string(),
      color: t.string(),
      isBot: t.bool(),
      botStyle: t.string(),
      state: t.string(),
      /** Pending hit reports, JSON [[amount, source], ...]. */
      hits: t.string(),
      skillsUsed: t.u32(),
      health: t.f64(),
      armor: t.f64(),
      dead: t.bool(),
      dealt: t.f64(),
    }
  ),
  raidTick: raidTickTable,
  /** Brain snapshots (θ per arm, flattened) every few fights: rollback + "v0 vs now" panel. */
  policySnapshot: table(
    { public: true },
    {
      version: t.u32().primaryKey(),
      at: t.timestamp(),
      fights: t.u32(),
      theta: t.array(t.f64()),
      n: t.array(t.u32()),
      rewardSum: t.array(t.f64()),
    }
  ),
});
export default spacetimedb;

function toRow(arm: number, m: ArmModel) {
  return { arm, a: m.A, b: m.b, ainv: m.Ainv, theta: m.theta, n: m.n, rewardSum: m.rewardSum };
}

export const init = spacetimedb.init(ctx => {
  // A fresh, untrained brain (version 0): every arm's model at its ridge prior.
  ARMS.forEach((_, i) => ctx.db.policyArm.insert(toRow(i, createArmModel())));
  ctx.db.policyMeta.insert({ id: 0, version: 0, fights: 0, decisions: 0, rejected: 0, wins: 0, losses: 0 });
  ctx.db.policySnapshot.insert({
    version: 0,
    at: ctx.timestamp,
    fights: 0,
    theta: new Array(ARMS.length * FEATURE_DIM).fill(0),
    n: new Array(ARMS.length).fill(0),
    rewardSum: new Array(ARMS.length).fill(0),
  });
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  if (!ctx.db.player.identity.find(ctx.sender)) {
    ctx.db.player.insert({ identity: ctx.sender, consented: false, joinedAt: ctx.timestamp, lastSubmitMicros: 0n });
  }
});

// Player opted in (or out) of contributing fight data to train Skynet.
export const setConsent = spacetimedb.reducer({ consented: t.bool() }, (ctx, { consented }) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new Error('unknown player');
  ctx.db.player.identity.update({ ...player, consented });
});

/**
 * A finished fight's scored decisions. The whole fight is validated before any of it is
 * learned from; rejected fights are recorded with a reason and never touch the brain.
 */
export const submitFight = spacetimedb.reducer(
  {
    policyVersion: t.u32(),
    outcome: t.string(),
    duration: t.f64(),
    arms: t.array(t.u32()),
    contexts: t.array(t.f64()),
    rewards: t.array(t.f64()),
    dealt: t.f64(),
    taken: t.f64(),
  },
  (ctx, args) => {
    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player) throw new Error('unknown player');
    const meta = ctx.db.policyMeta.id.find(0);
    if (!meta) throw new Error('brain not initialized');

    const sub: FightSubmission = { ...args, outcome: args.outcome as FightSubmission['outcome'] };
    const now = ctx.timestamp.microsSinceUnixEpoch;
    let reason = validateSubmission(sub);
    if (!reason && !player.consented) reason = 'player has not consented to training';
    if (!reason && args.policyVersion > meta.version) reason = 'unknown policy version';
    if (!reason && player.lastSubmitMicros > 0n && now - player.lastSubmitMicros < BigInt(SUBMIT_LIMITS.minInterval * 1_000_000)) reason = 'submitting too fast';

    const n = args.arms.length;
    ctx.db.fight.insert({
      id: 0n,
      player: ctx.sender,
      at: ctx.timestamp,
      outcome: args.outcome,
      duration: args.duration,
      decisions: n,
      dealt: args.dealt,
      taken: args.taken,
      meanReward: n ? args.rewards.reduce((s, r) => s + r, 0) / n : 0,
      policyVersion: args.policyVersion,
      accepted: !reason,
      reason: reason ?? '',
    });
    if (reason) {
      ctx.db.policyMeta.id.update({ ...meta, rejected: meta.rejected + 1 });
      return;
    }

    // Learn: load the brain, apply every decision, write back the arms that changed.
    const rows = [...ctx.db.policyArm.iter()].sort((x, y) => x.arm - y.arm);
    const policy: Policy = {
      version: meta.version,
      arms: rows.map(r => ({ A: [...r.a], b: [...r.b], Ainv: [...r.ainv], theta: [...r.theta], n: r.n, rewardSum: r.rewardSum })),
    };
    trainOn(policy, sub);
    for (const arm of new Set(args.arms)) ctx.db.policyArm.arm.update(toRow(arm, policy.arms[arm]));

    const updated = {
      ...meta,
      version: meta.version + 1,
      fights: meta.fights + 1,
      decisions: meta.decisions + n,
      wins: meta.wins + (args.outcome === 'won' ? 1 : 0),
      losses: meta.losses + (args.outcome === 'lost' ? 1 : 0),
    };
    ctx.db.policyMeta.id.update(updated);
    ctx.db.player.identity.update({ ...player, lastSubmitMicros: now });

    if (updated.fights % SNAPSHOT_EVERY === 0) {
      ctx.db.policySnapshot.insert({
        version: updated.version,
        at: ctx.timestamp,
        fights: updated.fights,
        theta: policy.arms.flatMap(m => m.theta),
        n: policy.arms.map(m => m.n),
        rewardSum: policy.arms.map(m => m.rewardSum),
      });
    }
  }
);

// =============================================================================================
// Co-op raids
// =============================================================================================

const arena = generateArena();
const RAID_BOT_STYLES: BotStyle[] = ['aggressor', 'kiter', 'dodger', 'sniper', 'hider'];
/** Effects the clients render (others are bookkeeping). */
const VFX_EVENTS = new Set(['telegraph', 'fire', 'impact', 'sweep', 'slam', 'dodged', 'bossHit', 'won', 'lost', 'lightningCast', 'lightning', 'beamFired', 'beamImpact', 'move', 'reflected', 'droneDestroyed', 'enraged', 'evaded']);
/** Seconds a finished raid stays visible (result screen) before it's cleaned up. */
const RAID_LINGER = 60;

// Reducer contexts are typed per call site; the helpers below only touch tables they name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

/** The shared brain, cached between ticks until its version changes (choosing needs θ only). */
let brainCache: { version: number; policy: Policy } | null = null;
function currentPolicy(ctx: Ctx): Policy | null {
  const meta = ctx.db.policyMeta.id.find(0);
  if (!meta) return null;
  if (!brainCache || brainCache.version !== meta.version) {
    const rows = [...ctx.db.policyArm.iter()].sort((x: { arm: number }, y: { arm: number }) => x.arm - y.arm);
    brainCache = {
      version: meta.version,
      policy: { version: meta.version, arms: rows.map((r: { ainv: number[]; theta: number[]; n: number; rewardSum: number }) => ({ A: [], b: [], Ainv: [...r.ainv], theta: [...r.theta], n: r.n, rewardSum: r.rewardSum })) },
    };
  }
  return brainCache.policy;
}

function ensureRaidTicker(ctx: Ctx): void {
  if ([...ctx.db.raidTick.iter()].length === 0) {
    ctx.db.raidTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BigInt(Math.round(1_000_000 / RAID.tickRate))) });
  }
}

/** Remove a player's raid membership; a raid with no humans left is deleted with its bots. */
function leaveRaids(ctx: Ctx, owner: string): void {
  for (const m of [...ctx.db.raidMember.iter()]) {
    if (m.owner !== owner) continue;
    ctx.db.raidMember.id.delete(m.id);
    const rest = [...ctx.db.raidMember.raidId.filter(m.raidId)];
    if (!rest.some((x: { isBot: boolean }) => !x.isBot)) {
      for (const x of rest) ctx.db.raidMember.id.delete(x.id);
      ctx.db.raid.id.delete(m.raidId);
    }
  }
}

const cleanName = (s: string) => s.replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 16) || 'Resistance fighter';
const cleanColor = (s: string) => (/^#[0-9a-fA-F]{6}$/.test(s) ? s : '#00e5ff');
const newMember = (raidId: bigint) => ({ id: 0n, raidId, owner: '', slot: 0, name: '', color: '', isBot: false, botStyle: '', state: '', hits: '[]', skillsUsed: 0, health: 100, armor: 50, dead: false, dealt: 0 });

/** Join the open raid lobby (or open a new one). Callsign/color are shown to your team. */
export const raidJoin = spacetimedb.reducer({ name: t.string(), color: t.string() }, (ctx, { name, color }) => {
  const owner = ctx.sender.toHexString();
  leaveRaids(ctx, owner);
  ensureRaidTicker(ctx);
  let raid = [...ctx.db.raid.iter()].find(r => r.status === 'lobby' && [...ctx.db.raidMember.raidId.filter(r.id)].filter(m => !m.isBot).length < RAID.size);
  if (!raid) {
    raid = ctx.db.raid.insert({ id: 0n, status: 'lobby', createdAt: ctx.timestamp, endedAtMicros: 0n, tick: 0, bossHp: 0, bossMaxHp: 0, policyVersion: 0, sim: '', events: '[]' });
  }
  ctx.db.raidMember.insert({ ...newMember(raid.id), owner, name: cleanName(name), color: cleanColor(color) });
});

export const raidLeave = spacetimedb.reducer(ctx => {
  leaveRaids(ctx, ctx.sender.toHexString());
});

/** Any member starts the raid: empty slots are filled with bots, and Skynet wakes up. */
export const raidStart = spacetimedb.reducer(ctx => {
  const owner = ctx.sender.toHexString();
  const me = [...ctx.db.raidMember.iter()].find(m => m.owner === owner);
  if (!me) throw new Error('not in a raid');
  const raid = ctx.db.raid.id.find(me.raidId);
  if (!raid || raid.status !== 'lobby') return;
  const humans = [...ctx.db.raidMember.raidId.filter(raid.id)].filter(m => !m.isBot).sort((a, b) => Number(a.id - b.id));
  const roster: (BotStyle | null)[] = humans.map(() => null);
  for (let i = 0; roster.length < RAID.size; i++) roster.push(RAID_BOT_STYLES[i % RAID_BOT_STYLES.length]);
  const sim = createRaid(arena, roster, Number(ctx.timestamp.microsSinceUnixEpoch % 1_000_000n) + 1);
  humans.forEach((h, slot) => ctx.db.raidMember.id.update({ ...h, slot }));
  roster.forEach((style, slot) => {
    if (!style) return;
    ctx.db.raidMember.insert({ ...newMember(raid.id), slot, name: `${style.toUpperCase()} BOT`, color: '#9aa3b2', isBot: true, botStyle: style });
  });
  const meta = ctx.db.policyMeta.id.find(0);
  ctx.db.raid.id.update({ ...raid, status: 'active', bossHp: sim.fight.boss.hp, bossMaxHp: sim.fight.boss.maxHp, policyVersion: meta?.version ?? 0, sim: raidToJson(sim), events: '[]' });
  ensureRaidTicker(ctx);
});

/** A human member streams its movement/animation state (JSON) ~20×/s. */
export const raidUpdate = spacetimedb.reducer({ state: t.string(), skillsUsed: t.u32() }, (ctx, { state, skillsUsed }) => {
  if (state.length > 4000) return;
  const owner = ctx.sender.toHexString();
  const me = [...ctx.db.raidMember.iter()].find(m => m.owner === owner);
  if (!me) return;
  ctx.db.raidMember.id.update({ ...me, state, skillsUsed: Math.min(30, me.skillsUsed + skillsUsed) });
});

/** A human member reports a hit on Skynet; validated and applied on the next tick. */
export const raidHit = spacetimedb.reducer({ amount: t.f64(), source: t.string() }, (ctx, { amount, source }) => {
  if (!['sword', 'beam', 'lightning', 'rush'].includes(source) || !(amount > 0)) return;
  const owner = ctx.sender.toHexString();
  const me = [...ctx.db.raidMember.iter()].find(m => m.owner === owner);
  if (!me) return;
  const hits = JSON.parse(me.hits) as [number, string][];
  if (hits.length >= 20) return;
  hits.push([amount, source]);
  ctx.db.raidMember.id.update({ ...me, hits: JSON.stringify(hits) });
});

/** The raid game loop: every active raid advances RAID.simSteps sim steps per tick. */
export const runRaids = spacetimedb.reducer({ onSchedule: raidTickTable }, { timer: raidTickTable.rowType }, ctx => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const raid of [...ctx.db.raid.iter()]) {
    const members = [...ctx.db.raidMember.raidId.filter(raid.id)];
    if (raid.status === 'lobby') {
      if (!members.some(m => !m.isBot)) ctx.db.raid.id.delete(raid.id);
      continue;
    }
    if (raid.status !== 'active') {
      if (now - raid.endedAtMicros > BigInt(RAID_LINGER * 1_000_000)) {
        for (const m of members) ctx.db.raidMember.id.delete(m.id);
        ctx.db.raid.id.delete(raid.id);
      }
      continue;
    }
    const policy = currentPolicy(ctx);
    if (!policy) continue;
    const sim = raidFromJson(raid.sim);
    const brain = learnedBrain(policy);
    const events: FightEvent[] = [];
    // Humans who left count as down; the rest apply their streamed state and queued hits.
    for (const sm of sim.members) {
      if (sm.bot || sm.dead) continue;
      const row = members.find(m => !m.isBot && m.slot === sm.id);
      if (!row) {
        sm.dead = true;
        continue;
      }
      if (row.state) {
        try {
          applyMemberState(sim, sm.id, JSON.parse(row.state), row.skillsUsed);
        } catch {
          /* ignore a malformed update */
        }
      }
      for (const [amount, source] of JSON.parse(row.hits) as [number, DamageSource][]) events.push(...applyMemberHit(sim, sm.id, amount, source));
      if (row.hits !== '[]' || row.skillsUsed) ctx.db.raidMember.id.update({ ...row, hits: '[]', skillsUsed: 0 });
    }
    for (let i = 0; i < RAID.simSteps; i++) events.push(...stepRaid(sim, arena, SIM_DT, brain));
    const outcome = sim.fight.outcome;
    // Write back members: vitals for everyone; movement for bots (the server runs their bodies).
    const rows = [...ctx.db.raidMember.raidId.filter(raid.id)];
    for (const sm of sim.members) {
      const row = rows.find(m => m.slot === sm.id && m.isBot === !!sm.bot);
      if (!row) continue;
      const s = sm.slot;
      const p = s.player;
      const state = sm.bot
        ? JSON.stringify({ pos: p.pos, vel: p.vel, yaw: p.yaw, onGround: p.onGround, invuln: p.invuln, dashTimer: p.dashTimer, climbing: p.climbing, gliding: p.gliding, airJumpCount: p.airJumpCount, swingTimer: p.swingTimer, comboStep: p.comboStep, rushing: p.rushing, shots: s.shots })
        : row.state;
      const changed = row.health !== s.health || row.armor !== s.armor || row.dead !== sm.dead || row.dealt !== sm.dealt || row.state !== state;
      if (changed) ctx.db.raidMember.id.update({ ...row, state, health: s.health, armor: s.armor, dead: sm.dead, dealt: sm.dealt });
    }
    ctx.db.raid.id.update({
      ...raid,
      status: outcome === 'active' ? 'active' : outcome,
      endedAtMicros: outcome === 'active' ? 0n : now,
      tick: raid.tick + 1,
      bossHp: sim.fight.boss.hp,
      sim: raidToJson(sim),
      events: JSON.stringify(events.filter(e => VFX_EVENTS.has(e.type)).slice(-40)),
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  leaveRaids(ctx, ctx.sender.toHexString());
});

// =============================================================================================
// One-time brain import (deploying a trained brain to a fresh database, e.g. Maincloud)
// =============================================================================================

/** Imports are only accepted into a brand-new database: brain v0, no fights learned. */
function assertFreshBrain(ctx: Ctx): void {
  const meta = ctx.db.policyMeta.id.find(0);
  if (!meta || meta.version !== 0 || meta.fights !== 0) throw new Error('brain import is only allowed into a fresh (v0) database');
}

/** Load one arm of a trained brain (from a backups/brain-*.json file). */
export const importBrainArm = spacetimedb.reducer(
  { arm: t.u32(), a: t.array(t.f64()), b: t.array(t.f64()), ainv: t.array(t.f64()), theta: t.array(t.f64()), n: t.u32(), rewardSum: t.f64() },
  (ctx, row) => {
    assertFreshBrain(ctx);
    const d = FEATURE_DIM;
    if (row.arm >= ARMS.length || row.a.length !== d * d || row.ainv.length !== d * d || row.b.length !== d || row.theta.length !== d) throw new Error('arm shape mismatch');
    if (![...row.a, ...row.b, ...row.ainv, ...row.theta].every(Number.isFinite)) throw new Error('non-finite values');
    ctx.db.policyArm.arm.update(row);
  }
);

/** Finish an import: set the brain's version and lifetime stats (closes the import window). */
export const importBrainMeta = spacetimedb.reducer(
  { version: t.u32(), fights: t.u32(), decisions: t.u32(), rejected: t.u32(), wins: t.u32(), losses: t.u32() },
  (ctx, meta) => {
    assertFreshBrain(ctx);
    if (meta.fights === 0) throw new Error('imported brain must have fights');
    ctx.db.policyMeta.id.update({ id: 0, ...meta });
    const arms = [...ctx.db.policyArm.iter()].sort((x, y) => x.arm - y.arm);
    ctx.db.policySnapshot.insert({
      version: meta.version,
      at: ctx.timestamp,
      fights: meta.fights,
      theta: arms.flatMap(r => r.theta),
      n: arms.map(r => r.n),
      rewardSum: arms.map(r => r.rewardSum),
    });
  }
);

