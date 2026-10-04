import { raycast, type Arena } from './arena';
import { SKILL_ORDER, STAMINA, VITALS } from './config';
import { ARMS, BOSS, playerChest, setContextExtractor, type Brain, type FightState } from './combat';
import { clamp } from './math';

// =============================================================================================
// Skynet's learning brain: a disjoint LinUCB contextual bandit.
// Shared by the client (choosing), the SpacetimeDB module (learning), and the bot trainer.
// =============================================================================================

// ---------------------------------------------------------------------------------------------
// Context features
// ---------------------------------------------------------------------------------------------

export const FEATURE_NAMES = [
  'bias',
  'distance',
  'height above Skynet',
  'player visible',
  'under a roof',
  'speed',
  'closing in',
  'airborne',
  'climbing',
  'stamina',
  'can dodge now',
  'health',
  'armor',
  'lightning ready',
  'rush ready',
  'beam ready',
  'Skynet energy',
  'Skynet HP',
  'projectiles in flight',
  'dodge rate',
] as const;
export const FEATURE_DIM = FEATURE_NAMES.length;

/** The situation Skynet sees when deciding, normalized to roughly [-1.5, 1.5]. */
export function computeFeatures(f: FightState, arena: Arena): number[] {
  const p = f.player;
  const b = f.boss;
  const chest = playerChest(p);
  const dx = chest.x - b.pos.x;
  const dy = chest.y - b.pos.y;
  const dz = chest.z - b.pos.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const hs = Math.hypot(p.vel.x, p.vel.z);
  // Positive when moving toward Skynet.
  const closing = -(dx * p.vel.x + dy * p.vel.y + dz * p.vel.z) / dist;
  const visible = raycast(arena, b.pos, chest, f.time) >= 1 ? 1 : 0;
  const roof = raycast(arena, chest, { x: chest.x, y: chest.y + 25, z: chest.z }, f.time) < 1 ? 1 : 0;
  const canDodge = p.dashCooldown <= 0 && p.stamina >= STAMINA.dashCost ? 1 : 0;
  const dodgeRate = f.recentDodges.length ? f.recentDodges.reduce((a, v) => a + v, 0) / f.recentDodges.length : 0.5;
  // Every feature is bounded so one odd value can't dominate (or fail server validation).
  const bound = (v: number) => clamp(v, -1.5, 1.5);
  return [
    1,
    Math.min(dist / 100, 1.5),
    clamp(dy / 25, -1, 1),
    visible,
    roof,
    Math.min(hs / 28, 1.5),
    clamp(closing / 28, -1.5, 1.5),
    !p.onGround && !p.climbing ? 1 : 0,
    p.climbing ? 1 : 0,
    p.stamina / STAMINA.max,
    canDodge,
    f.health / VITALS.health,
    f.armor / VITALS.armor,
    ...SKILL_ORDER.map((_, i) => (f.skillCd[i] <= 0 ? 1 : 0)),
    b.energy / BOSS.maxEnergy,
    b.hp / BOSS.maxHp,
    Math.min(f.projectiles.length / 10, 1.5),
    dodgeRate,
  ].map(bound);
}
setContextExtractor(computeFeatures);

// ---------------------------------------------------------------------------------------------
// LinUCB
// ---------------------------------------------------------------------------------------------

export const LINUCB = {
  /** Ridge prior strength (A starts as λI). */
  lambda: 1,
  /** Exploration bonus weight. */
  alpha: 0.6,
  /** Forgetting factor: older data fades (~1/(1-γ) = 1000 updates of memory per arm). */
  gamma: 0.999,
};

/** One arm's ridge-regression model. Matrices are row-major d×d arrays. */
export interface ArmModel {
  A: number[];
  b: number[];
  /** Cached A⁻¹ and θ = A⁻¹b (what clients need to score). */
  Ainv: number[];
  theta: number[];
  /** Updates applied and their summed reward (for the brain panel). */
  n: number;
  rewardSum: number;
}

export interface Policy {
  version: number;
  arms: ArmModel[];
}

export function createArmModel(d = FEATURE_DIM, lambda = LINUCB.lambda): ArmModel {
  const A = new Array(d * d).fill(0);
  const Ainv = new Array(d * d).fill(0);
  for (let i = 0; i < d; i++) {
    A[i * d + i] = lambda;
    Ainv[i * d + i] = 1 / lambda;
  }
  return { A, b: new Array(d).fill(0), Ainv, theta: new Array(d).fill(0), n: 0, rewardSum: 0 };
}

export function createPolicy(): Policy {
  return { version: 0, arms: ARMS.map(() => createArmModel()) };
}

/** Gauss-Jordan inverse with partial pivoting. Returns null if singular. */
export function invert(M: number[], d: number): number[] | null {
  const a = M.slice();
  const inv = new Array(d * d).fill(0);
  for (let i = 0; i < d; i++) inv[i * d + i] = 1;
  for (let col = 0; col < d; col++) {
    let pivot = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(a[r * d + col]) > Math.abs(a[pivot * d + col])) pivot = r;
    const pv = a[pivot * d + col];
    if (Math.abs(pv) < 1e-12) return null;
    if (pivot !== col) {
      for (let k = 0; k < d; k++) {
        [a[col * d + k], a[pivot * d + k]] = [a[pivot * d + k], a[col * d + k]];
        [inv[col * d + k], inv[pivot * d + k]] = [inv[pivot * d + k], inv[col * d + k]];
      }
    }
    for (let k = 0; k < d; k++) {
      a[col * d + k] /= pv;
      inv[col * d + k] /= pv;
    }
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = a[r * d + col];
      if (factor === 0) continue;
      for (let k = 0; k < d; k++) {
        a[r * d + k] -= factor * a[col * d + k];
        inv[r * d + k] -= factor * inv[col * d + k];
      }
    }
  }
  return inv;
}

function matVec(M: number[], x: number[], d: number): number[] {
  const out = new Array(d).fill(0);
  for (let i = 0; i < d; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += M[i * d + j] * x[j];
    out[i] = s;
  }
  return out;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Predicted reward (no exploration bonus). */
export function predict(m: ArmModel, x: number[]): number {
  return dot(m.theta, x);
}

/** UCB score: predicted reward + α·uncertainty. */
export function armScore(m: ArmModel, x: number[], alpha = LINUCB.alpha): number {
  const d = x.length;
  const u = dot(x, matVec(m.Ainv, x, d));
  return predict(m, x) + alpha * Math.sqrt(Math.max(0, u));
}

/**
 * Learn from one (context, reward): A ← γA + (1−γ)λI + xxᵀ, b ← γb + r·x, then recompute A⁻¹
 * and θ exactly. Re-adding (1−γ)λI keeps the ridge prior from decaying away under forgetting.
 */
export function updateArm(m: ArmModel, x: number[], r: number, opts = LINUCB): void {
  const d = x.length;
  const g = opts.gamma;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) m.A[i * d + j] = g * m.A[i * d + j] + x[i] * x[j] + (i === j ? (1 - g) * opts.lambda : 0);
    m.b[i] = g * m.b[i] + r * x[i];
  }
  const inv = invert(m.A, d);
  if (inv) {
    m.Ainv = inv;
    m.theta = matVec(inv, m.b, d);
  }
  m.n++;
  m.rewardSum += r;
}

/**
 * Pick the valid arm with the best UCB score. Exact ties (e.g. an untrained policy, where every
 * arm scores the same) are broken with `rng` — otherwise the lowest index (always "wait") would
 * win every tie and a fresh brain would never explore. Pass the fight's seeded RNG to stay
 * deterministic; without one, ties go to the lowest index.
 */
export function selectArm(policy: Policy, x: number[], valid: number[], alpha = LINUCB.alpha, rng?: () => number): number {
  let best = valid[0];
  let bestScore = -Infinity;
  let ties = 0;
  for (const i of valid) {
    const s = armScore(policy.arms[i], x, alpha);
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = i;
      ties = 1;
    } else if (rng && Math.abs(s - bestScore) <= 1e-9) {
      // Reservoir sampling over tied arms: each tied arm is equally likely.
      ties++;
      if (rng() * ties < 1) best = i;
    }
  }
  return best;
}

/** A Brain backed by a (frozen) policy; ties broken with the fight's seeded RNG. */
export function learnedBrain(policy: Policy): Brain {
  return (f, _arena, valid, context) => selectArm(policy, context, valid, LINUCB.alpha, f.rng);
}

// ---------------------------------------------------------------------------------------------
// Fight submissions (client → server) and validation
// ---------------------------------------------------------------------------------------------

export interface FightSubmission {
  policyVersion: number;
  outcome: 'won' | 'lost' | 'abandoned';
  duration: number;
  /** Per decision, flattened: arms[i], contexts[i*d .. i*d+d), rewards[i]. */
  arms: number[];
  contexts: number[];
  rewards: number[];
  /** Fight totals, for stats. */
  dealt: number;
  taken: number;
}

export const SUBMIT_LIMITS = {
  minDuration: 5,
  maxDuration: 1800,
  /** Decisions per second can't exceed this (waits are 0.5 s, attacks longer). */
  maxRate: 2.5,
  maxDecisions: 600,
  /** Seconds between submissions from the same identity. */
  minInterval: 5,
  featureBound: 1.5,
};

/** Package a finished fight's scored decisions for submit_fight. */
export function toSubmission(f: FightState, policyVersion: number, outcome: FightSubmission['outcome']): FightSubmission {
  const done = f.decisions.filter(d => d.resolved && d.context.length === FEATURE_DIM);
  return {
    policyVersion,
    outcome,
    duration: f.time,
    arms: done.map(d => d.arm),
    contexts: done.flatMap(d => d.context),
    rewards: done.map(d => d.reward),
    dealt: f.decisions.reduce((s, d) => s + d.dealt, 0),
    taken: f.decisions.reduce((s, d) => s + d.taken, 0),
  };
}

/** Server-side checks before a fight may train the shared brain. Returns a rejection reason or null. */
export function validateSubmission(s: FightSubmission): string | null {
  const L = SUBMIT_LIMITS;
  const n = s.arms.length;
  if (!['won', 'lost', 'abandoned'].includes(s.outcome)) return 'bad outcome';
  if (!(s.duration >= L.minDuration && s.duration <= L.maxDuration)) return 'implausible duration';
  if (n === 0) return 'no decisions';
  if (n > L.maxDecisions || n > s.duration * L.maxRate + 5) return 'too many decisions for the fight length';
  if (s.rewards.length !== n || s.contexts.length !== n * FEATURE_DIM) return 'malformed arrays';
  for (const a of s.arms) if (!Number.isInteger(a) || a < 0 || a >= ARMS.length) return 'unknown arm';
  for (const r of s.rewards) if (!Number.isFinite(r) || r < -1 || r > 1) return 'reward out of range';
  for (let i = 0; i < n; i++) {
    if (s.contexts[i * FEATURE_DIM] !== 1) return 'missing bias feature';
    for (let j = 0; j < FEATURE_DIM; j++) {
      const v = s.contexts[i * FEATURE_DIM + j];
      if (!Number.isFinite(v) || Math.abs(v) > L.featureBound) return 'feature out of range';
    }
  }
  if (!(s.dealt >= 0 && s.taken >= 0)) return 'bad totals';
  return null;
}

/** Apply a validated submission to a policy (server-side; also used by tests and offline training). */
export function trainOn(policy: Policy, s: FightSubmission): void {
  for (let i = 0; i < s.arms.length; i++) {
    updateArm(policy.arms[s.arms[i]], s.contexts.slice(i * FEATURE_DIM, (i + 1) * FEATURE_DIM), s.rewards[i]);
  }
  policy.version++;
}
