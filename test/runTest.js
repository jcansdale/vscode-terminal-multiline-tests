const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  try {
    // Use local Code OSS build if VSCODE_PATH is set
    const vscodeExecutablePath = process.env.VSCODE_PATH;

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
    });
  } catch (error) {
    console.error('Failed to run tests');
    console.error(error);
    process.exit(1);
  }
}

main();