// Headless sanity check for sim/: runs the player controller without a browser.
// Usage: npx tsx tools/sim-smoke.ts
import { ARENA_WALK_RADIUS, createPlayer, heightAt, NO_INPUT, SIM_DT, stepPlayer, type PlayerInput } from '@sao/sim';

function run(label: string, ticks: number, input: (tick: number) => PlayerInput, start = { x: 0, z: 30 }) {
  const p = createPlayer(start.x, start.z);
  let maxY = -Infinity;
  let maxSpeed = 0;
  for (let i = 0; i < ticks; i++) {
    stepPlayer(p, input(i), SIM_DT);
    maxY = Math.max(maxY, p.pos.y - heightAt(p.pos.x, p.pos.z));
    maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.z));
  }
  const r = Math.hypot(p.pos.x, p.pos.z);
  console.log(
    `${label.padEnd(22)} pos=(${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}) r=${r.toFixed(1)} ` +
      `onGround=${p.onGround} maxHeightAboveGround=${maxY.toFixed(2)} maxSpeed=${maxSpeed.toFixed(1)}`
  );
  return { p, r, maxY, maxSpeed };
}

const fwd = (extra: Partial<PlayerInput> = {}) => (): PlayerInput => ({ ...NO_INPUT, moveZ: -1, ...extra });

const idle = run('idle 2s', 120, () => NO_INPUT);
const walk = run('run toward center 1s', 60, fwd());
const sprint = run('sprint 1s', 60, fwd({ sprint: true }));
const jump = run('single jump', 90, t => ({ ...NO_INPUT, jump: t === 0 }));
const dbl = run('double jump', 120, t => ({ ...NO_INPUT, jump: t === 0 || t === 30 }));
const dash = run('dash', 30, t => ({ ...NO_INPUT, moveZ: -1, dash: t === 0 }));
const wall = run('run into rim 10s', 600, () => ({ ...NO_INPUT, moveZ: 1, sprint: true }));

const checks: [string, boolean][] = [
  ['idle stays grounded', idle.p.onGround && Math.abs(idle.p.pos.z - 30) < 0.01],
  ['run speed ~10', Math.abs(walk.maxSpeed - 10) < 0.5],
  ['sprint speed ~16', Math.abs(sprint.maxSpeed - 16) < 0.5],
  ['jump lands', jump.p.onGround && jump.maxY > 2],
  ['double jump goes higher', dbl.maxY > jump.maxY + 1],
  ['dash bursts > 30', dash.maxSpeed > 30],
  ['rim boundary holds', wall.r <= ARENA_WALK_RADIUS + 1e-6],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
