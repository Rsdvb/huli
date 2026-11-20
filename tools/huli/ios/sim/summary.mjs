// The table of what measure.sh sampled, as Markdown for the run's summary: a row a scenario, a
// column for each process sampled, as CPU of one core (average / busiest second) and memory.
// Usage: node summary.mjs <samples.jsonl>. Huli's own; see tools/huli/README.md.

import { readFileSync } from 'node:fs'

const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
  (key) => !['name', 'seconds', 'at', 'top', 'frames'].includes(key),
)
const cell = (value) =>
  value === null || value === undefined
    ? '-'
    : typeof value === 'object'
      ? `${value.cpu}% / ${value.peak}% / ${value.rssMb} MB`
      : String(value)
console.log(
  [
    `| Scenario | ${keys.join(' | ')} |`,
    `| --- | ${keys.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.name} | ${keys.map((key) => cell(row[key])).join(' | ')} |`),
    '',
    'CPU of one core, average / busiest second, and resident memory, over each window.',
  ].join('\n'),
)
