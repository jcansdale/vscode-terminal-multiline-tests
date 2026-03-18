const fs = require('fs');

const resultsPath = process.env.TEST_RESULTS_PATH;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (!resultsPath || !summaryPath) {
  console.log('Missing TEST_RESULTS_PATH or GITHUB_STEP_SUMMARY');
  process.exit(0);
}

let results;
try {
  results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
} catch (e) {
  console.log(`No test results found at ${resultsPath}`);
  process.exit(0);
}

const passed = results.filter(r => r.state === 'passed').length;
const failed = results.filter(r => r.state === 'failed').length;
const skipped = results.filter(r => r.state === 'skipped').length;

const icon = failed > 0 ? '❌' : '✅';
let md = `### ${icon} ${passed} passed, ${failed} failed, ${skipped} skipped\n\n`;
md += '| Test | Status | Duration |\n';
md += '|------|--------|----------|\n';

for (const r of results) {
  const status = r.state === 'passed' ? '✅ passed' : r.state === 'failed' ? '❌ failed' : '⏭️ skipped';
  const duration = r.duration != null ? `${r.duration}ms` : '-';
  md += `| ${r.title} | ${status} | ${duration} |\n`;
}

if (failed > 0) {
  md += '\n### Failures\n\n';
  for (const r of results.filter(r => r.state === 'failed')) {
    md += `<details><summary>${r.title}</summary>\n\n\`\`\`\n${r.error || 'No error message'}\n\`\`\`\n\n</details>\n\n`;
  }
}

fs.appendFileSync(summaryPath, md);
console.log(`Wrote summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
