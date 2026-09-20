import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('/tmp/jobs3.json', 'utf8'));
for (const j of data.jobs) {
  const failed = j.steps.filter((s) => s.conclusion && !['success', 'skipped'].includes(s.conclusion)).map((s) => s.name);
  console.log(`${j.name}: ${j.conclusion}${failed.length ? ' | failed: ' + failed.join(', ') : ''}`);
}
