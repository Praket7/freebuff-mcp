import fs from 'node:fs';
const input = process.argv[2] ?? process.env.JOBS_FILE;
if (!input) {
  console.error('Usage: node scripts/ci-report.mjs <jobs.json>');
  console.error('Where jobs.json is the response of /actions/runs/<id>/jobs?per_page=100');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
for (const j of data.jobs) {
  const failed = j.steps.filter((s) => s.conclusion && !['success', 'skipped'].includes(s.conclusion)).map((s) => s.name);
  console.log(`${j.name}: ${j.conclusion}${failed.length ? ' | failed: ' + failed.join(', ') : ''}`);
}
