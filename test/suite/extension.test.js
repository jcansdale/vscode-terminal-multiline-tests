const assert = require('assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const COMMAND = `echo 'L01 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L02 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L03 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L04 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L05 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L06 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L07 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L08 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L09 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L10 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L11 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L12 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L13 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L14 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L15 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L16 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L17 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L18 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
L19 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | wc -c`;

function withRedirect(outputFilePath) {
  return `${COMMAND} > "${outputFilePath}"`;
}

async function waitForShellIntegration(terminal, timeoutMs) {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return await new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, timeoutMs);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timeoutHandle);
        disposable.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}

async function waitForFileText(filePath, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (content.trim()) {
        return content;
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting ${timeoutMs}ms for ${label} output file`);
}

async function createTempPaths() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-terminal-repro-'));
  return {
    tempDir,
    first: path.join(tempDir, 'first.txt'),
    second: path.join(tempDir, 'second.txt'),
  };
}

async function cleanupTempPaths(paths) {
  await fs.rm(paths.tempDir, { recursive: true, force: true });
}

async function createTerminalRepro(name) {
  return {
    terminal: vscode.window.createTerminal(name),
    paths: await createTempPaths(),
  };
}

async function assertExpectedOutput(paths, name) {
  const firstOutput = await waitForFileText(paths.first, 7000, `first ${name}`);
  const secondOutput = await waitForFileText(paths.second, 7000, `second ${name}`);

  assert.ok(firstOutput.includes('1064'));
  assert.ok(secondOutput.includes('1064'));
}

async function runExecuteCommandTwice(terminal, paths) {
  const shellIntegration = await waitForShellIntegration(terminal, 3000);
  assert.ok(shellIntegration, 'Expected terminal shell integration');

  shellIntegration.executeCommand(withRedirect(paths.first));
  await waitForFileText(paths.first, 7000, 'first executeCommand repro');

  shellIntegration.executeCommand(withRedirect(paths.second));
}

async function runSendTextTwice(terminal, paths) {
  terminal.sendText(withRedirect(paths.first), true);
  await waitForFileText(paths.first, 7000, 'first sendText repro');

  terminal.sendText(withRedirect(paths.second), true);
}

suite('Integration test', () => {
  test('executeCommand twice', async function () {
    this.timeout(20000);

    const repro = await createTerminalRepro('executeCommand repro');

    try {
      repro.terminal.show(true);
      await runExecuteCommandTwice(repro.terminal, repro.paths);
      await assertExpectedOutput(repro.paths, 'executeCommand repro');
    } finally {
      repro.terminal.dispose();
      await cleanupTempPaths(repro.paths);
    }
  });

  test('sendText twice', async function () {
    this.timeout(20000);

    const repro = await createTerminalRepro('sendText repro');

    try {
      repro.terminal.show(true);
      await runSendTextTwice(repro.terminal, repro.paths);
      await assertExpectedOutput(repro.paths, 'sendText repro');
    } finally {
      repro.terminal.dispose();
      await cleanupTempPaths(repro.paths);
    }
  });
});