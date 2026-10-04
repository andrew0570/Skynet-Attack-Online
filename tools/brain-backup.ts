// Save a local backup of Skynet's brain, in the same format as the training backups.
// Usage:
//   npm run brain:backup            current brain from the local DB → backups/brain-<stamp>-v<N>.json
//   npm run brain:backup -- --v0    the untrained version-0 brain (what the server seeds)
//                                   → backups/brain-v0.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARMS, createPolicy, FEATURE_DIM, FEATURE_NAMES, LINUCB } from '@sao/sim';

const OUT = join(process.cwd(), 'backups');
mkdirSync(OUT, { recursive: true });
const URI = process.env.SAO_DB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.SAO_DB ?? 'skynet-attack-online';

// Self-describing: feature names, what each arm index means, and the LinUCB settings.
const describe = { featureNames: [...FEATURE_NAMES], armDefs: ARMS, linucb: LINUCB };

if (process.argv.includes('--v0')) {
  const p = createPolicy();
  const data = {
    exportedAt: new Date().toISOString(),
    note: 'Untrained version-0 brain: every arm at its ridge prior (A = λI, b = 0, θ = 0), exactly what the server seeds in init.',
    meta: { id: 0, version: 0, fights: 0, decisions: 0, rejected: 0, wins: 0, losses: 0 },
    arms: p.arms.map((m, arm) => ({ arm, n: m.n, rewardSum: m.rewardSum, a: m.A, b: m.b, ainv: m.Ainv, theta: m.theta })),
    snapshots: [{ version: 0, fights: 0, theta: new Array(ARMS.length * FEATURE_DIM).fill(0), n: new Array(ARMS.length).fill(0), rewardSum: new Array(ARMS.length).fill(0) }],
    ...describe,
  };
  const file = join(OUT, 'brain-v0.json');
  writeFileSync(file, JSON.stringify(data));
  console.log(`Saved untrained brain v0 → ${file}`);
  process.exit(0);
}

const { DbConnection } = await import('../client/src/module_bindings');
const conn = await new Promise<InstanceType<typeof DbConnection>>((resolve, reject) => {
  DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect(c =>
      c
        .subscriptionBuilder()
        .onApplied(() => resolve(c))
        .subscribe(['SELECT * FROM policy_meta', 'SELECT * FROM policy_arm', 'SELECT * FROM policy_snapshot'])
    )
    .onConnectError((_ctx, e) => reject(e))
    .build();
});
const meta = conn.db.policyMeta.id.find(0)!;
const data = {
  exportedAt: new Date().toISOString(),
  meta: { ...meta },
  arms: [...conn.db.policyArm.iter()].sort((a, b) => a.arm - b.arm).map(r => ({ arm: r.arm, n: r.n, rewardSum: r.rewardSum, a: [...r.a], b: [...r.b], ainv: [...r.ainv], theta: [...r.theta] })),
  snapshots: [...conn.db.policySnapshot.iter()].map(s => ({ version: s.version, fights: s.fights, at: s.at.microsSinceUnixEpoch.toString(), theta: [...s.theta], n: [...s.n], rewardSum: [...s.rewardSum] })),
  ...describe,
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = join(OUT, `brain-${stamp}-v${meta.version}.json`);
writeFileSync(file, JSON.stringify(data));
console.log(`Saved brain v${meta.version} (${meta.fights} fights) → ${file}`);
conn.disconnect();
process.exit(0);
