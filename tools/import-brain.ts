// Load a trained brain backup into a fresh database (its brain must still be v0).
// Usage: npx tsx tools/import-brain.ts <backups/brain-*.json> [uri] [database]
//   e.g. npx tsx tools/import-brain.ts backups/brain-round4-it1500-v1500.json wss://maincloud.spacetimedb.com skynet-attack-online-andrew0570
import { readFileSync } from 'node:fs';
import { DbConnection } from '../client/src/module_bindings';

const [file, uri = 'ws://127.0.0.1:3000', db = 'skynet-attack-online'] = process.argv.slice(2);
if (!file) throw new Error('usage: import-brain.ts <backup.json> [uri] [database]');
type Backup = {
  meta: { version: number; fights: number; decisions: number; rejected: number; wins: number; losses: number };
  arms: { arm: number; n: number; rewardSum: number; a: number[]; b: number[]; ainv: number[]; theta: number[] }[];
};
const backup = JSON.parse(readFileSync(file, 'utf8')) as Backup;

const conn: DbConnection = await new Promise((resolve, reject) => {
  DbConnection.builder()
    .withUri(uri)
    .withDatabaseName(db)
    .onConnect(c => c.subscriptionBuilder().onApplied(() => resolve(c)).subscribe(['SELECT * FROM policy_meta']))
    .onConnectError((_c, e) => reject(e))
    .build();
});
const before = conn.db.policyMeta.id.find(0);
console.log(`${db}: brain v${before?.version}, ${before?.fights} fights. Importing v${backup.meta.version} (${backup.arms.length} arms) from ${file}`);
for (const r of backup.arms) {
  await conn.reducers.importBrainArm({ arm: r.arm, a: r.a, b: r.b, ainv: r.ainv, theta: r.theta, n: r.n, rewardSum: r.rewardSum });
}
const m = backup.meta;
await conn.reducers.importBrainMeta({ version: m.version, fights: m.fights, decisions: m.decisions, rejected: m.rejected, wins: m.wins, losses: m.losses });
await new Promise(r => setTimeout(r, 1000));
const after = conn.db.policyMeta.id.find(0);
console.log(`Done: brain v${after?.version}, ${after?.fights} fights.`);
conn.disconnect();
process.exit(after?.version === m.version ? 0 : 1);
