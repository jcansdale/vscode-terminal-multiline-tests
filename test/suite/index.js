const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  await new Promise((resolve, reject) => {
    const runner = mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }

      resolve();
    });

    // Collect results for CI summary
    const results = [];
    runner.on('pass', (test) => {
      results.push({ title: test.fullTitle(), state: 'passed', duration: test.duration });
    });
    runner.on('fail', (test, err) => {
      results.push({ title: test.fullTitle(), state: 'failed', duration: test.duration, error: err.message });
    });
    runner.on('pending', (test) => {
      results.push({ title: test.fullTitle(), state: 'skipped' });
    });
    runner.on('end', () => {
      const outPath = process.env.TEST_RESULTS_PATH;
      if (outPath) {
        try {
          fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
        } catch (e) {
          console.error('Failed to write test results:', e.message);
        }
      }
    });
  });
}

module.exports = {
  run,
};