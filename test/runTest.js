const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  try {
    // Use local Code OSS build if VSCODE_PATH is set
    const vscodeExecutablePath = process.env.VSCODE_PATH;
    // Use VSCODE_VERSION to select stable/insiders (default: stable)
    const version = process.env.VSCODE_VERSION || 'stable';
    // For dev builds, VSCODE_SOURCE_DIR points Electron at the VS Code source
    const vscodeSourceDir = process.env.VSCODE_SOURCE_DIR;
    // Path to write JSON test results for CI summary
    const testResultsPath = process.env.TEST_RESULTS_PATH;

    const extensionTestsEnv = {
      ...(testResultsPath ? { TEST_RESULTS_PATH: testResultsPath } : {}),
      ...(vscodeSourceDir ? { VSCODE_DEV: '1', ELECTRON_ENABLE_LOGGING: '1' } : {}),
    };

    await runTests({
      vscodeExecutablePath,
      version,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      ...(vscodeSourceDir ? { launchArgs: [vscodeSourceDir, '--log', 'debug'] } : {}),
      ...(Object.keys(extensionTestsEnv).length > 0 ? { extensionTestsEnv } : {}),
    });
  } catch (error) {
    console.error('Failed to run tests');
    console.error(error);
    process.exit(1);
  }
}

main();