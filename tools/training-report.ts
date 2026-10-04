// Builds a training report page from a training round's stats and backups.
// Usage:
//   npm run train:report                       newest training-*.json → backups/skynet-training.html
//   npm run train:report -- --round 2          backups/training-round2.json → backups/skynet-training-round2.html
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = join(process.cwd(), 'backups');
const roundArg = process.argv.indexOf('--round');
const round = roundArg >= 0 ? process.argv[roundArg + 1] : null;
const trainingFile = round
  ? join(dir, `training-round${round}.json`)
  : readdirSync(dir)
      .filter(f => /^training-.*\.json$/.test(f))
      .map(f => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!trainingFile) throw new Error('No backups/training-*.json found. Run npm run train:bots first.');

const training = JSON.parse(readFileSync(trainingFile, 'utf8'));
const prefix = (training.round as string | undefined) ?? (training.startedAt as string);
const backups = readdirSync(dir)
  .map(f => /^brain-(.+)-(?:run|it)(\d+)-v(\d+)\.json$/.exec(f))
  .filter((m): m is RegExpExecArray => !!m && m[1] === prefix)
  .map(m => ({ file: m[0], run: Number(m[2]), version: Number(m[3]) }))
  .sort((a, b) => a.run - b.run);

const title = round ? `Skynet Training Round ${round}` : 'Skynet Bot Training';
const data = { stats: training.stats, backups, generatedAt: new Date().toLocaleString(), title, round };
const template = readFileSync(join(process.cwd(), 'tools', 'training-report.html'), 'utf8');
const out = join(dir, round ? `skynet-training-round${round}.html` : 'skynet-training.html');
writeFileSync(out, template.replace('<title>Skynet Bot Training</title>', `<title>${title}</title>`).replace('__DATA__', JSON.stringify(data)));
console.log(`Report: ${out} (${training.stats.length} runs from ${basename(trainingFile)}, ${backups.length} backups)`);
