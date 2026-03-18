const assert = require('assert');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const LINE_COUNT = 19;
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
  { shellPath: '/bin/bash', shellArgs: ['--norc', '--noprofile', '-i'], defaultArgs: [] },
  { shellPath: '/bin/zsh', shellArgs: ['-i'], defaultArgs: [] },  // No -f to allow shell integration
  { shellPath: '/bin/dash', shellArgs: ['-i'], defaultArgs: ['-i'] },
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

async function waitForCommandCompletion(terminal, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, timeoutMs);

    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timeoutHandle);
        disposable.dispose();
        resolve(event.execution);
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

const SEND_COUNT = 5;  // Run 5x to stress test

async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-terminal-repro-'));
}

async function cleanupTempDir(tempDir) {
  await fs.rm(tempDir, { recursive: true, force: true });
}

function createTerminal(name, shellPath, shellArgs) {
  return vscode.window.createTerminal({
    name,
    shellPath,
    shellArgs,
  });
}

async function assertExpectedOutput(outputs, name, terminal) {
  const errors = [];
  for (const { label, content } of outputs) {
    if (content === '<timed out>') {
      errors.push(`${label}: timed out`);
    } else {
      const err = validateByteCount(content, label);
      if (err) {
        errors.push(err);
      }
    }
  }

  let terminalText;
  try {
    terminalText = await getTerminalContents(terminal);
  } catch (e) {
    terminalText = `<failed to capture: ${e.message}>`;
  }

  const details = [
    ...outputs.map(o => `--- ${o.label} ---\n${errors.find(e => e.startsWith(o.label)) || 'OK'}`),
    `--- terminal contents ---`,
    terminalText,
  ].join('\n');

  console.log(`${name}:\n${details}`);

  if (errors.length > 0) {
    assert.fail(`${name} failed (${errors.length}/${outputs.length}):\n${details}`);
  }
}

suite('Multiline terminal repro', () => {
  suiteSetup(async () => {
    // Enable shell integration like terminal-mcp does
    await vscode.workspace.getConfiguration('terminal.integrated').update('shellIntegration.enabled', true, vscode.ConfigurationTarget.Global);
  });

  for (const shell of shellMatrix) {
    const shellName = path.basename(shell.shellPath);

    for (const count of [1, SEND_COUNT]) {
    test(`executeCommand ${count}x (${shellName})`, async function () {
      if (!fsSync.existsSync(shell.shellPath)) {
        this.skip();
      }
      this.timeout(60000);

      const tempDir = await createTempDir();
      const terminal = createTerminal(`executeCommand ${count}x ${shellName}`, shell.shellPath, shell.defaultArgs);

      try {
        terminal.show(true);

        const shellIntegration = await waitForShellIntegration(terminal, 5000);
        if (!shellIntegration) {
          this.skip();
        }

        const outputs = [];
        for (let i = 1; i <= count; i++) {
          const filePath = path.join(tempDir, `output-${i}.txt`);
          const completionPromise = waitForCommandCompletion(terminal, 7000);
          shellIntegration.executeCommand(`${COMMAND} > "${filePath}"`);
          let content;
          try {
            content = await waitForFileText(filePath, 7000, `#${i} executeCommand`);
          } catch (e) {
            content = '<timed out>';
          }
          await completionPromise;
          // Give the PTY time to fully flush after shell reports completion
          // terminal-mcp uses 2000ms for this delay
          await new Promise(resolve => setTimeout(resolve, 2000));
          outputs.push({ label: `#${i}`, content });
          if (content === '<timed out>') {
            break;
          }
        }
        await assertExpectedOutput(outputs, `executeCommand ${count}x ${shellName}`, terminal);
      } finally {
        terminal.dispose();
        await cleanupTempDir(tempDir);
      }
    })

    test(`sendText ${count}x (${shellName})`, async function () {
      if (!fsSync.existsSync(shell.shellPath)) {
        this.skip();
      }
      this.timeout(120000);

      const tempDir = await createTempDir();
      const terminal = createTerminal(`sendText ${count}x ${shellName}`, shell.shellPath, shell.shellArgs);

      try {
        terminal.show(true);

        // Wait for shell to be ready before sending text
        await new Promise(resolve => setTimeout(resolve, 1000));

        const shellIntegration = await waitForShellIntegration(terminal, 3000);
        
        // Warm-up command
        if (shellIntegration) {
          const warmupCompletion = waitForCommandCompletion(terminal, 5000);
          terminal.sendText('echo ready', true);
          await warmupCompletion;
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          terminal.sendText('echo ready', true);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const outputs = [];
        for (let i = 1; i <= count; i++) {
          const filePath = path.join(tempDir, `output-${i}.txt`);
          const completionPromise = shellIntegration
            ? waitForCommandCompletion(terminal, 7000)
            : null;
          
          terminal.sendText(`${COMMAND} > "${filePath}"`, true);
          
          let content;
          try {
            content = await waitForFileText(filePath, 7000, `#${i} sendText`);
          } catch (e) {
            content = '<timed out>';
          }
          
          if (completionPromise) {
            await completionPromise;
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
          outputs.push({ label: `#${i}`, content });
          if (content === '<timed out>') {
            break;
          }
        }
        await assertExpectedOutput(outputs, `sendText ${count}x ${shellName}`, terminal);
      } finally {
        terminal.dispose();
        await cleanupTempDir(tempDir);
      }
    });
    }
  }
});