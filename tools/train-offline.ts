// Offline dry run: bots vs a local brain (no database), to sanity-check balance and learning
// before a real training round. Usage: npx tsx tools/train-offline.ts [runs]
import { ARMS, armLabel, createFight, createPolicy, describeStyle, FEATURE_DIM, FEATURE_NAMES, STYLE_FEATURE_START, generateArena, learnedBrain, mulberry32, resolveDecisions, SIM_DT, stepFight, toSubmission, trainOn, validateSubmission } from '@sao/sim';
import { BOT_STYLES, botInput, createBot } from './bots';

const RUNS = Number(process.argv[2] ?? 200);
const arena = generateArena();
const rng = mulberry32(7);
const policy = createPolicy();
type Row = { style: string; skynetWon: boolean; dealt: number; use: number[]; read: string; habits: number[] };
const rows: Row[] = [];
const t0 = Date.now();
for (let run = 1; run <= RUNS; run++) {
  const style = BOT_STYLES[(run - 1) % BOT_STYLES.length];
  const f = createFight(arena, 100000 + run);
  const bot = createBot(style, f, arena, mulberry32(Math.floor(rng() * 2 ** 31)));
  const brain = learnedBrain(policy);
  while (f.outcome === 'active' && f.time < 120) stepFight(f, arena, botInput(bot, f, arena), SIM_DT, brain);
  resolveDecisions(f, true);
  const sub = toSubmission(f, policy.version, f.outcome === 'won' ? 'won' : f.outcome === 'lost' ? 'lost' : 'abandoned');
  const bad = validateSubmission(sub);
  if (bad) console.log(`run ${run} rejected: ${bad}`);
  else trainOn(policy, sub);
  // Mean habit features over the fight's decisions (what the brain actually saw).
  const n = sub.arms.length || 1;
  const habits = FEATURE_NAMES.slice(STYLE_FEATURE_START).map((_, k) => sub.arms.reduce((s, _a, i) => s + sub.contexts[i * FEATURE_DIM + STYLE_FEATURE_START + k], 0) / n);
  rows.push({ style, skynetWon: f.outcome === 'lost', dealt: sub.dealt, use: ARMS.map((_, i) => sub.arms.filter(a => a === i).length), read: describeStyle(f.style).label, habits });
}
console.log(`${RUNS} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`habits (mean feature value): ${FEATURE_NAMES.slice(STYLE_FEATURE_START).map(h => h.replace('habit: ', '')).join(' | ')}`);
for (const style of BOT_STYLES) {
  const rs = rows.filter(r => r.style === style);
  console.log(`  ${style.padEnd(9)} ${rs[0].habits.map((_, k) => (rs.reduce((s, r) => s + r.habits[k], 0) / rs.length).toFixed(2)).join('  ')}`);
}

const half = Math.floor(RUNS / 2);
for (const style of BOT_STYLES) {
  for (const [name, part] of [['first half', rows.slice(0, half)], ['second half', rows.slice(half)]] as const) {
    const rs = part.filter(r => r.style === style);
    const use = ARMS.map((_, i) => rs.reduce((s, r) => s + r.use[i], 0));
    const total = use.reduce((a, b) => a + b, 0) || 1;
    const top = use.map((n, i) => ({ n, i })).filter(x => x.i !== 0).sort((a, b) => b.n - a.n).slice(0, 4);
    const reads = [...new Set(rs.map(r => r.read))].map(l => `${l}×${rs.filter(r => r.read === l).length}`).join(' ');
    console.log(`${style.padEnd(9)} ${name.padEnd(11)} Skynet wins ${String(rs.filter(r => r.skynetWon).length).padStart(2)}/${rs.length}  dmg ${(rs.reduce((s, r) => s + r.dealt, 0) / rs.length).toFixed(0).padStart(3)}  wait ${((100 * use[0]) / total).toFixed(0)}%  top: ${top.map(x => `${armLabel(ARMS[x.i])} ${((100 * x.n) / total).toFixed(0)}%`).join(', ')}  | read: ${reads}`);
  }
}

// Overall: does Skynet use its whole kit, and does it move?
for (const [name, part] of [['first half', rows.slice(0, half)], ['second half', rows.slice(half)]] as const) {
  const use = ARMS.map((_, i) => part.reduce((s, r) => s + r.use[i], 0));
  const total = use.reduce((a, b) => a + b, 0) || 1;
  const moves = ARMS.reduce((s, a, i) => s + (a.kind === 'move' ? use[i] : 0), 0);
  const used = use.filter((n, i) => i > 0 && n / total >= 0.02).length;
  const top = use.map((n, i) => ({ n, i })).filter(x => x.i !== 0).sort((a, b) => b.n - a.n).slice(0, 8);
  console.log(`ALL ${name.padEnd(11)} Skynet wins ${part.filter(r => r.skynetWon).length}/${part.length}  wait ${((100 * use[0]) / total).toFixed(0)}%  moves ${((100 * moves) / total).toFixed(0)}%  options used ≥2%: ${used}/24`);
  console.log(`    top: ${top.map(x => `${armLabel(ARMS[x.i])} ${((100 * x.n) / total).toFixed(0)}%`).join(', ')}`);
}
