#!/usr/bin/env node
// Compares the per-type results in src/data/emulatorSupport.json against a previous copy.
// Timestamps and durations always change; only a change in what works counts.
//   node scripts/compare-emulator-support.mjs <previous.json> <current.json> <summary.md>
// Exits 0 and writes the summary when results changed, exits 3 when they did not.
import fs from 'node:fs';

const [previousPath, currentPath, summaryPath] = process.argv.slice(2);
const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : { byType: {} });
const before = read(previousPath).byType || {};
const after = read(currentPath).byType || {};

const label = (entry) => (entry ? entry.status : 'untested');
const rows = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .sort()
  .filter((type) => label(before[type]) !== label(after[type]))
  .map((type) => {
    const error = after[type]?.status === 'fails' ? ` - ${after[type].errors[0]?.slice(0, 160) || ''}` : '';
    return `| \`${type}\` | ${label(before[type])} | ${label(after[type])}${error.replace(/\|/g, '\\|')} |`;
  });

if (rows.length === 0) {
  console.log('Emulator support unchanged.');
  process.exit(3);
}

const count = (byType, status) => Object.values(byType).filter((e) => e.status === status).length;
fs.writeFileSync(
  summaryPath,
  `The weekly emulator run (\`npm run test:emulator\`) found a change in which resource types work.

| Resource type | Before | Now |
|---|---|---|
${rows.join('\n')}

Totals: ${count(after, 'verified')} verified, ${count(after, 'second-apply')} need a second Apply, ${count(after, 'fails')} fail.
A type that starts failing is either a compiler change or an emulator change; check the error before merging.
`
);
console.log(`${rows.length} resource type(s) changed.`);
