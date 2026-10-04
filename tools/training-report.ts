// Builds backups/skynet-training.html from the newest training run's stats and backups.
// Usage: npm run train:report   (optionally: npx tsx tools/training-report.ts <training-json>)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = join(process.cwd(), 'backups');
const trainingFile =
  process.argv[2] ??
  readdirSync(dir)
    .filter(f => /^training-.*\.json$/.test(f))
    .map(f => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!trainingFile) throw new Error('No backups/training-*.json found. Run npm run train:bots first.');

const training = JSON.parse(readFileSync(trainingFile, 'utf8'));
const stamp = training.startedAt as string;
const backups = readdirSync(dir)
  .map(f => /^brain-(.+)-run(\d+)-v(\d+)\.json$/.exec(f))
  .filter((m): m is RegExpExecArray => !!m && m[1] === stamp)
  .map(m => ({ file: m[0], run: Number(m[2]), version: Number(m[3]) }))
  .sort((a, b) => a.run - b.run);

const data = { stats: training.stats, backups, generatedAt: new Date().toLocaleString() };
const template = readFileSync(join(process.cwd(), 'tools', 'training-report.html'), 'utf8');
const out = join(dir, 'skynet-training.html');
writeFileSync(out, template.replace('__DATA__', JSON.stringify(data)));
console.log(`Report: ${out} (${training.stats.length} runs from ${basename(trainingFile)}, ${backups.length} backups)`);
