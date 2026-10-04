// End-to-end raid check against the local DB: join, start (bots fill the team), stream a
// position, report a hit, and confirm the server-side raid loop advances.
// Usage: npx tsx tools/raid-smoke.ts   (needs npm run db:start + the module published)
import { DbConnection } from '../client/src/module_bindings';

const conn: DbConnection = await new Promise((resolve, reject) => {
  DbConnection.builder()
    .withUri('ws://127.0.0.1:3000')
    .withDatabaseName('skynet-attack-online')
    .onConnect(c => c.subscriptionBuilder().onApplied(() => resolve(c)).subscribe(['SELECT * FROM raid', 'SELECT * FROM raid_member']))
    .onConnectError((_c, e) => reject(e))
    .build();
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const me = () => conn.identity!.toHexString();
const myRow = () => [...conn.db.raidMember.iter()].find(m => m.owner === me());
const results: [string, boolean, string][] = [];

conn.reducers.raidJoin({ name: 'Smoke Test', color: '#ff4fd8' });
await sleep(500);
const joined = myRow();
results.push(['join puts me in a lobby', !!joined && conn.db.raid.id.find(joined.raidId)?.status === 'lobby', joined ? `raid ${joined.raidId}` : 'no row']);

conn.reducers.raidStart({});
await sleep(600);
const raid0 = joined && conn.db.raid.id.find(joined.raidId);
const team = joined ? [...conn.db.raidMember.iter()].filter(m => m.raidId === joined.raidId) : [];
results.push(['start fills the team to 5 with bots', raid0?.status === 'active' && team.length === 5 && team.filter(m => m.isBot).length === 4, `${team.length} members: ${team.map(m => m.name).join(', ')}`]);

// Stand near spawn and stream state for a few seconds.
for (let i = 0; i < 40; i++) {
  conn.reducers.raidUpdate({ state: JSON.stringify({ pos: { x: 0, y: 0, z: 30 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true }), skillsUsed: 0 });
  await sleep(50);
}
const raid1 = joined && conn.db.raid.id.find(joined.raidId);
const bot = [...conn.db.raidMember.iter()].find(m => m.raidId === joined?.raidId && m.isBot);
results.push(['server ticks the raid (~20/s)', !!raid0 && !!raid1 && raid1.tick - raid0.tick >= 25, `ticks ${raid0?.tick} → ${raid1?.tick}`]);
results.push(['bots move and fight server-side', !!bot?.state && !!raid1 && raid1.bossHp < raid1.bossMaxHp, `Skynet ${raid1?.bossHp.toFixed(0)} / ${raid1?.bossMaxHp} HP`]);
const events = raid1 ? (JSON.parse(raid1.events) as { type: string }[]).map(e => e.type) : [];
results.push(['raid row carries effects for clients', raid1 !== undefined && raid1.sim.length > 1000, `last tick events: ${[...new Set(events)].join(', ') || 'none'}`]);

conn.reducers.raidLeave({});
await sleep(400);
results.push(['leaving removes my row and the raid (no humans left)', !myRow() && !(joined && conn.db.raid.id.find(joined.raidId)), '']);

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
conn.disconnect();
process.exit(failed ? 1 : 0);
