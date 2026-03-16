const assert = require('assert');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const LINE_COUNT = 19;
const PAYLOAD_COUNT = 10;
const EXPECTED_LINES = [];
for (let i = 1; i <= LINE_COUNT; i++) {
  EXPECTED_LINES.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(51)}`);
}

// Total bytes: 19 lines × 55 chars + 18 newlines between lines + 1 trailing newline from echo = 1064
const EXPECTED_BYTE_COUNT = EXPECTED_LINES.join('\n').length + 1;

const ECHO_BODY = `echo '${EXPECTED_LINES.join('\n')}'`;

const COMMAND = `${ECHO_BODY} | wc -c`;

function validateByteCount(content, label) {
  const actual = parseInt(content.trim(), 10);
  if (isNaN(actual)) {
    return `${label}: expected a number, got ${JSON.stringify(content.trim())}`;
  }
  if (actual !== EXPECTED_BYTE_COUNT) {
    return `${label}: expected ${EXPECTED_BYTE_COUNT} bytes, got ${actual}`;
  }
  return null;
}

const shellMatrix = [
  { shellPath: '/bin/bash', shellArgs: ['--norc', '--noprofile', '-i'] },
  { shellPath: '/bin/zsh', shellArgs: ['-f', '-i'] },
  { shellPath: '/bin/dash', shellArgs: ['-i'] },
];

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

async function getTerminalContents(terminal) {
  // Select all terminal text, read it from the clipboard, then restore
  const previousClipboard = await vscode.env.clipboard.readText();
  await vscode.window.showTerminalPanel?.(terminal) ?? terminal.show(true);
  await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
  await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
  await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
  const contents = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(previousClipboard);
  return contents;
}

async function createTempPaths() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-terminal-repro-'));
  const files = [];
  for (let i = 1; i <= PAYLOAD_COUNT; i++) {
    files.push(path.join(tempDir, `output-${i}.txt`));
  }
  return { tempDir, files };
}

async function cleanupTempPaths(paths) {
  await fs.rm(paths.tempDir, { recursive: true, force: true });
}

function createTerminal(name, shell) {
  return vscode.window.createTerminal({
    name,
    shellPath: shell.shellPath,
    shellArgs: shell.shellArgs,
  });
}

async function assertExpectedOutput(paths, name, terminal) {
  const outputs = [];
  for (let i = 0; i < paths.files.length; i++) {
    try {
      outputs.push(await waitForFileText(paths.files[i], 7000, `#${i + 1} ${name}`));
    } catch (e) {
      outputs.push('<timed out>');
    }
  }

  const errors = outputs.map((output, i) => {
    const label = `#${i + 1}`;
    if (output === '<timed out>') {
      return `${label}: timed out`;
    }
    return validateByteCount(output, label);
  });

  let terminalText;
  try {
    terminalText = await getTerminalContents(terminal);
  } catch (e) {
    terminalText = `<failed to capture: ${e.message}>`;
  }

  const details = errors.map((err, i) => `--- #${i + 1} ---\n${err || 'OK'}`).join('\n');
  console.log(`${name}:\n${details}\n--- terminal contents ---\n${terminalText}`);

  const failed = errors.filter(e => e !== null);
  if (failed.length > 0) {
    assert.fail(`${name} failed (${failed.length}/${PAYLOAD_COUNT}):\n${details}\n--- terminal contents ---\n${terminalText}`);
  }
}

suite('Multiline terminal repro', () => {
  for (const shell of shellMatrix) {
    const shellName = path.basename(shell.shellPath);

    test(`executeCommand ${PAYLOAD_COUNT}x (${shellName})`, async function () {
      if (!fsSync.existsSync(shell.shellPath)) {
        this.skip();
      }
      this.timeout(20000 + PAYLOAD_COUNT * 8000);

      const paths = await createTempPaths();
      const terminal = createTerminal(`executeCommand ${shellName}`, shell);

      try {
        terminal.show(true);

        const shellIntegration = await waitForShellIntegration(terminal, 3000);
        if (!shellIntegration) {
          this.skip();
        }

        for (let i = 0; i < PAYLOAD_COUNT; i++) {
          shellIntegration.executeCommand(`${COMMAND} > "${paths.files[i]}"`);
          if (i < PAYLOAD_COUNT - 1) {
            await waitForFileText(paths.files[i], 7000, `#${i + 1} executeCommand`);
          }
        }
        await assertExpectedOutput(paths, `executeCommand ${shellName}`, terminal);
      } finally {
        terminal.dispose();
        await cleanupTempPaths(paths);
      }
    });

    test(`sendText ${PAYLOAD_COUNT}x (${shellName})`, async function () {
      if (!fsSync.existsSync(shell.shellPath)) {
        this.skip();
      }
      this.timeout(20000 + PAYLOAD_COUNT * 8000);

      const paths = await createTempPaths();
      const terminal = createTerminal(`sendText ${shellName}`, shell);

      try {
        terminal.show(true);

        // Wait for shell to be ready before sending text
        await new Promise(resolve => setTimeout(resolve, 1000));

        for (let i = 0; i < PAYLOAD_COUNT; i++) {
          terminal.sendText(`${COMMAND} > "${paths.files[i]}"`, true);
          if (i < PAYLOAD_COUNT - 1) {
            await waitForFileText(paths.files[i], 7000, `#${i + 1} sendText`);
          }
        }
        await assertExpectedOutput(paths, `sendText ${shellName}`, terminal);
      } finally {
        terminal.dispose();
        await cleanupTempPaths(paths);
      }
    });
  }
});