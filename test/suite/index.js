const path = require('path');
const Mocha = require('mocha');

async function run() {
  const isCI = !!process.env.CI;
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    reporter: isCI ? 'mocha-junit-reporter' : 'spec',
    reporterOptions: isCI ? {
      mochaFile: process.env.MOCHA_FILE || path.resolve(__dirname, '../../test-results.xml'),
      suiteName: `${process.env.RUNNER_OS || 'unknown-os'} / VS Code ${process.env.VSCODE_VERSION || 'stable'}`,
    } : {},
  });

  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  run,
};