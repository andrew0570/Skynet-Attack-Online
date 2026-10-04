import { schema, table, t } from 'spacetimedb/server';
import {
  ARMS,
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
