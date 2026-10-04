// End-to-end check of the SpacetimeDB brain: consent, validation, rate limit, and learning.
// Needs the local DB running with the module published (npm run db:start, npm run db:publish).
// Usage: npx tsx tools/db-smoke.ts
import { createFight, generateArena, heuristicBrain, NO_INPUT, resolveDecisions, SIM_DT, stepFight, toSubmission } from '@sao/sim';
import { DbConnection } from '../client/src/module_bindings';

const URI = process.env.SAO_DB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.SAO_DB ?? 'skynet-attack-online';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const conn = await new Promise<DbConnection>((resolve, reject) => {
  const c = DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect(c2 => {
      c2.subscriptionBuilder()
        .onApplied(() => resolve(c2))
        .subscribe(['SELECT * FROM policy_meta', 'SELECT * FROM policy_arm', 'SELECT * FROM fight', 'SELECT * FROM player']);
    })
    .onConnectError((_ctx, e) => reject(e))
    .build();
  void c;
});

/** Wait until `pred` holds (table updates arrive asynchronously). */
async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}
const meta = () => conn.db.policyMeta.id.find(0)!;
const fights = () => [...conn.db.fight.iter()].sort((a, b) => Number(a.id - b.id));
const lastFight = () => fights()[fights().length - 1];

// A real 30 s fight from the shared sim, scored and packaged exactly like the client does it.
const arena = generateArena();
const f = createFight(arena, 42);
for (let i = 0; i < 60 * 30; i++) stepFight(f, arena, NO_INPUT, SIM_DT, heuristicBrain);
resolveDecisions(f, true);

const v0 = meta().version;
const nFights0 = fights().length;

conn.reducers.setConsent({ consented: false });
await sleep(300);
conn.reducers.submitFight(toSubmission(f, v0, 'abandoned'));
await until(() => fights().length > nFights0);
check('fight without consent is recorded but rejected', lastFight()?.accepted === false && lastFight()?.reason.includes('consent') && meta().version === v0, lastFight()?.reason ?? 'no row');

conn.reducers.setConsent({ consented: true });
await sleep(300);
const armsBefore = [...conn.db.policyArm.iter()].reduce((s, r) => s + r.n, 0);
conn.reducers.submitFight(toSubmission(f, v0, 'abandoned'));
await until(() => meta().version === v0 + 1);
const armsAfter = [...conn.db.policyArm.iter()].reduce((s, r) => s + r.n, 0);
check('consented fight is accepted and trains the shared brain', lastFight()?.accepted === true && meta().version === v0 + 1 && armsAfter - armsBefore === f.decisions.length,
  `version ${v0} → ${meta().version}, arm updates +${armsAfter - armsBefore} (${f.decisions.length} decisions)`);

const nBefore = fights().length;
conn.reducers.submitFight(toSubmission(f, meta().version, 'abandoned'));
await until(() => fights().length > nBefore);
check('immediate resubmission is rate-limited', lastFight()?.accepted === false && lastFight()?.reason === 'submitting too fast', lastFight()?.reason ?? 'no row');

const tampered = toSubmission(f, meta().version, 'abandoned');
tampered.rewards[0] = 5;
const nBefore2 = fights().length;
conn.reducers.submitFight(tampered);
await until(() => fights().length > nBefore2);
check('tampered rewards are rejected', lastFight()?.accepted === false && lastFight()?.reason === 'reward out of range', lastFight()?.reason ?? 'no row');

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} FAILED` : 'all passed');
conn.disconnect();
process.exit(failed ? 1 : 0);
