// Automated training: bot players fight Skynet and submit every fight through the real server
// (validation and all), so the shared brain learns exactly as it would from humans.
// Needs the local DB running with the module published.
// Usage: npm run train:bots            (RUNS=250 BACKUP_EVERY=50 by default)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARMS,
  armLabel,
  createFight,
  describeStyle,
  generateArena,
  learnedBrain,
  mulberry32,
  resolveDecisions,
  SIM_DT,
  stepFight,
  SUBMIT_LIMITS,
  toSubmission,
  type Policy,
} from '@sao/sim';
import { DbConnection } from '../client/src/module_bindings';
import { BOT_STYLES, botInput, createBot } from './bots';

const URI = process.env.SAO_DB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.SAO_DB ?? 'skynet-attack-online';
const RUNS = Number(process.env.RUNS ?? 250);
const BACKUP_EVERY = Number(process.env.BACKUP_EVERY ?? 50);
const IDENTITIES = Number(process.env.BOT_IDENTITIES ?? 12);
const MAX_FIGHT = 120;
const OUT = join(process.cwd(), 'backups');
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
/** Names this training round in file names: brain-<round>-it0050-v50.json, training-<round>.json. */
const ROUND = process.env.ROUND ? `round${process.env.ROUND}` : STAMP;
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function connect(subscribe: boolean): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect(c => {
        if (!subscribe) return resolve(c);
        c.subscriptionBuilder()
          .onApplied(() => resolve(c))
          .subscribe(['SELECT * FROM policy_meta', 'SELECT * FROM policy_arm', 'SELECT * FROM policy_snapshot']);
      })
      .onConnectError((_ctx, e) => reject(e))
      .build();
  });
}

// One reader connection (sees the brain update live) + a pool of bot identities that submit.
const reader = await connect(true);
const bots = await Promise.all(Array.from({ length: IDENTITIES }, () => connect(false)));
for (const b of bots) b.reducers.setConsent({ consented: true });
await sleep(500);
const lastSubmit = new Array(IDENTITIES).fill(0);

const meta = () => reader.db.policyMeta.id.find(0)!;
function currentPolicy(): Policy {
  const rows = [...reader.db.policyArm.iter()].sort((a, b) => a.arm - b.arm);
  return { version: meta().version, arms: rows.map(r => ({ A: [...r.a], b: [...r.b], Ainv: [...r.ainv], theta: [...r.theta], n: r.n, rewardSum: r.rewardSum })) };
}

/** Full local copy of the shared brain (meta, every arm's model, all snapshots). */
function backup(run: number): string {
  const m = meta();
  const file = join(OUT, `brain-${ROUND}-it${String(run).padStart(4, "0")}-v${m.version}.json`);
  const data = {
    exportedAt: new Date().toISOString(),
    run,
    meta: { ...m },
    arms: [...reader.db.policyArm.iter()].sort((a, b) => a.arm - b.arm).map(r => ({ arm: r.arm, n: r.n, rewardSum: r.rewardSum, a: [...r.a], b: [...r.b], ainv: [...r.ainv], theta: [...r.theta] })),
    snapshots: [...reader.db.policySnapshot.iter()].map(s => ({ version: s.version, fights: s.fights, at: s.at.microsSinceUnixEpoch.toString(), theta: [...s.theta], n: [...s.n], rewardSum: [...s.rewardSum] })),
  };
  writeFileSync(file, JSON.stringify(data));
  return file;
}

interface RunStat {
  run: number;
  style: string;
  outcome: 'skynet' | 'bot' | 'timeout';
  duration: number;
  decisions: number;
  skynetDamage: number;
  botDamage: number;
  skynetHpLeft: number;
  meanReward: number;
  policyVersion: number;
  accepted: boolean;
  /** How many times Skynet picked each arm this fight (index = arm). */
  armUse: number[];
  /** Skynet's read of the bot's style at the end of the fight. */
  read: string;
}
const stats: RunStat[] = [];

const arena = generateArena();
const rng = mulberry32(20261004);
const t0 = Date.now();
console.log(`Training ${ROUND}: ${RUNS} runs, backups every ${BACKUP_EVERY}, ${IDENTITIES} bot identities. Brain starts at v${meta().version}.`);
console.log(`  backup → ${backup(0)}`); // the starting brain (iteration 0)

for (let run = 1; run <= RUNS; run++) {
  const policy = currentPolicy();
  const style = BOT_STYLES[(run - 1) % BOT_STYLES.length];
  const f = createFight(arena, 100000 + run);
  const bot = createBot(style, f, arena, mulberry32(Math.floor(rng() * 2 ** 31)));
  const brain = learnedBrain(policy);
  while (f.outcome === 'active' && f.time < MAX_FIGHT) stepFight(f, arena, botInput(bot, f, arena), SIM_DT, brain);
  resolveDecisions(f, true);
  const outcome = f.outcome === 'won' ? 'won' : f.outcome === 'lost' ? 'lost' : 'abandoned';
  const sub = toSubmission(f, policy.version, outcome);

  // Respect the per-identity rate limit, then submit and wait for the server's verdict.
  const id = run % IDENTITIES;
  const wait = lastSubmit[id] + (SUBMIT_LIMITS.minInterval + 0.3) * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const before = meta();
  bots[id].reducers.submitFight(sub);
  lastSubmit[id] = Date.now();
  let accepted = false;
  for (let i = 0; i < 200; i++) {
    const m = meta();
    if (m.version > before.version) {
      accepted = true;
      break;
    }
    if (m.rejected > before.rejected) break;
    await sleep(25);
  }

  stats.push({
    run,
    style,
    outcome: outcome === 'lost' ? 'skynet' : outcome === 'won' ? 'bot' : 'timeout',
    duration: f.time,
    decisions: sub.arms.length,
    skynetDamage: sub.dealt,
    botDamage: sub.taken,
    skynetHpLeft: f.boss.hp,
    meanReward: sub.rewards.length ? sub.rewards.reduce((s, r) => s + r, 0) / sub.rewards.length : 0,
    policyVersion: policy.version,
    accepted,
    armUse: ARMS.map((_, i) => sub.arms.filter(a => a === i).length),
    read: describeStyle(f.style).label,
  });

  if (run % 10 === 0) {
    const block = stats.slice(-10);
    const pct = (k: RunStat['outcome']) => `${block.filter(s => s.outcome === k).length * 10}%`.padStart(4);
    const avg = (fn: (s: RunStat) => number) => block.reduce((s, x) => s + fn(x), 0) / block.length;
    console.log(
      `runs ${String(run - 9).padStart(3)}-${String(run).padStart(3)} | Skynet wins ${pct('skynet')} | bot wins ${pct('bot')} | timeouts ${pct('timeout')} | ` +
        `Skynet dmg ${avg(s => s.skynetDamage).toFixed(0).padStart(3)} | reward ${avg(s => s.meanReward).toFixed(3)} | brain v${meta().version} | ${((Date.now() - t0) / 1000).toFixed(0)} s`
    );
  }
  if (run % BACKUP_EVERY === 0 || run === RUNS) console.log(`  backup → ${backup(run)}`);
  writeFileSync(join(OUT, `training-${ROUND}.json`), JSON.stringify({ startedAt: STAMP, round: ROUND, runs: RUNS, armLabels: ARMS.map(armLabel), stats }, null, 1));
}

const rejected = stats.filter(s => !s.accepted).length;
console.log(`Done: ${RUNS} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${rejected} rejected. Brain now v${meta().version}. Stats: backups/training-${ROUND}.json`);
for (const b of [reader, ...bots]) b.disconnect();
process.exit(0);
