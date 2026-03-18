const assert = require('assert');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

function createPayload(lineCount) {
  const expectedLines = [];
  for (let i = 1; i <= lineCount; i++) {
    expectedLines.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(51)}`);
  }

  return {
    lineCount,
    expectedByteCount: expectedLines.join('\n').length + 1,
    command: `echo '${expectedLines.join('\n')}' | wc -c`,
  };
}

const SEND_COUNT = 5;  // Run 5x to stress test
const OPERATION_IDLE_TIMEOUT_MS = 5000;

const PAYLOAD_MATRIX = [
  { name: '19-line payload', payload: createPayload(19), counts: [1, SEND_COUNT] },
  { name: '40-line payload', payload: createPayload(40), counts: [SEND_COUNT] },
  { name: '50-line payload', payload: createPayload(50), counts: [SEND_COUNT] },
];

function validateByteCount(content, label, expectedByteCount) {
  const actual = parseInt(content.trim(), 10);
  if (isNaN(actual)) {
    return `${label}: expected a number, got ${JSON.stringify(content.trim())}`;
  }
  if (actual !== expectedByteCount) {
    return `${label}: expected ${expectedByteCount} bytes, got ${actual}`;
  }
  return null;
}

const shellMatrix = [
  { shellPath: '/bin/bash', shellArgs: ['-i'] },
  { shellPath: '/bin/zsh', shellArgs: ['-i'] },
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

function getShellIntegrationTimeout(shellPath) {
  if (process.platform === 'darwin' && shellPath === '/bin/zsh') {
    return 20000;
  }

  return 5000;
}

async function getShellIntegrationWithWarmup(terminal, shellPath) {
  const timeoutMs = getShellIntegrationTimeout(shellPath);

  let shellIntegration = await waitForShellIntegration(terminal, timeoutMs);
  if (shellIntegration) {
    return shellIntegration;
  }

  if (process.platform === 'darwin' && shellPath === '/bin/zsh') {
    for (let attempt = 1; attempt <= 2; attempt++) {
      terminal.sendText('echo ready', true);
      await new Promise(resolve => setTimeout(resolve, 2000));
      shellIntegration = terminal.shellIntegration || await waitForShellIntegration(terminal, 5000);
      if (shellIntegration) {
        return shellIntegration;
      }
      console.log(`zsh shell integration still unavailable after warm-up attempt ${attempt}`);
    }
  }

  return undefined;
}

async function waitForFileTextOrTerminalIdle(filePath, terminal, idleTimeoutMs, label) {
  let lastActivityTime = Date.now();
  let lastTerminalText;
  let hasTerminalSnapshot = false;
  let nextTerminalPollTime = lastActivityTime;

  while (true) {
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

    if (Date.now() >= nextTerminalPollTime) {
      try {
        const terminalText = await getTerminalContentsWithTimeout(terminal, 1000);
        if (hasTerminalSnapshot) {
          if (terminalText !== lastTerminalText) {
            lastActivityTime = Date.now();
          }
        } else {
          hasTerminalSnapshot = true;
        }
        lastTerminalText = terminalText;
      } catch {
        // Ignore clipboard/selection errors while polling for terminal activity.
      }

      nextTerminalPollTime = Date.now() + 1000;
    }

    if (Date.now() - lastActivityTime >= idleTimeoutMs) {
      throw new Error(`Timed out after ${idleTimeoutMs}ms of terminal inactivity for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

async function getTerminalContentsWithTimeout(terminal, timeoutMs) {
  return await Promise.race([
    getTerminalContents(terminal),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms reading terminal contents`)), timeoutMs);
    }),
  ]);
}

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

async function warmupShellIntegration(shell) {
  if (!fsSync.existsSync(shell.shellPath)) {
    return;
  }

  const shellName = path.basename(shell.shellPath);
  const terminal = createTerminal(`shellIntegration warmup ${shellName}`, shell.shellPath, shell.shellArgs);

  try {
    terminal.show(true);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const shellIntegration = await getShellIntegrationWithWarmup(terminal, shell.shellPath);
    console.log(`shell integration warmup (${shellName}): ${shellIntegration ? 'ready' : 'unavailable'}`);
  } finally {
    terminal.dispose();
  }
}

async function assertExpectedOutput(outputs, name, terminal, expectedByteCount) {
  const errors = [];
  for (const { label, content } of outputs) {
    if (content === '<timed out>') {
      errors.push(`${label}: timed out`);
    } else {
      const err = validateByteCount(content, label, expectedByteCount);
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
  suiteSetup(async function () {
    this.timeout(60000);

    // Enable shell integration like terminal-mcp does
    await vscode.workspace.getConfiguration('terminal.integrated').update('shellIntegration.enabled', true, vscode.ConfigurationTarget.Global);

    for (const shell of shellMatrix) {
      await warmupShellIntegration(shell);
    }
  });

  for (const shell of shellMatrix) {
    const shellName = path.basename(shell.shellPath);

    for (const { name: payloadName, payload, counts } of PAYLOAD_MATRIX) {
    for (const count of counts) {
    test(`executeCommand ${count}x (${shellName}, ${payloadName})`, async function () {
      if (!fsSync.existsSync(shell.shellPath)) {
        this.skip();
      }
      this.timeout(120000);

      const tempDir = await createTempDir();
      const terminal = createTerminal(`executeCommand ${count}x ${shellName}`, shell.shellPath, shell.shellArgs);

      try {
        terminal.show(true);

        // Give the shell a moment to start before waiting for integration.
        await new Promise(resolve => setTimeout(resolve, 1000));

        const shellIntegration = await getShellIntegrationWithWarmup(terminal, shell.shellPath);

        if (!shellIntegration) {
          console.log(`Skipping executeCommand ${count}x (${shellName}, ${payloadName}): shell integration unavailable`);
          this.skip();
        }

        const outputs = [];
        for (let i = 1; i <= count; i++) {
          const filePath = path.join(tempDir, `output-${i}.txt`);
          const completionPromise = waitForCommandCompletion(terminal, OPERATION_IDLE_TIMEOUT_MS);
          shellIntegration.executeCommand(`${payload.command} > "${filePath}"`);
          let content;
          try {
            content = await waitForFileTextOrTerminalIdle(filePath, terminal, OPERATION_IDLE_TIMEOUT_MS, `#${i} executeCommand`);
          } catch (e) {
            content = '<timed out>';
          }
          outputs.push({ label: `#${i}`, content });
          if (content === '<timed out>') {
            break;
          }
          await completionPromise;
          // Give the PTY time to fully flush after shell reports completion
          // terminal-mcp uses 2000ms for this delay
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        await assertExpectedOutput(outputs, `executeCommand ${count}x ${shellName} (${payloadName})`, terminal, payload.expectedByteCount);
      } finally {
        terminal.dispose();
        await cleanupTempDir(tempDir);
      }
    })

    test(`sendText ${count}x (${shellName}, ${payloadName})`, async function () {
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
            ? waitForCommandCompletion(terminal, OPERATION_IDLE_TIMEOUT_MS)
            : null;
          
          terminal.sendText(`${payload.command} > "${filePath}"`, true);
          
          let content;
          try {
            content = await waitForFileTextOrTerminalIdle(filePath, terminal, OPERATION_IDLE_TIMEOUT_MS, `#${i} sendText`);
          } catch (e) {
            content = '<timed out>';
          }

          outputs.push({ label: `#${i}`, content });
          if (content === '<timed out>') {
            break;
          }

          if (completionPromise) {
            await completionPromise;
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
        await assertExpectedOutput(outputs, `sendText ${count}x ${shellName} (${payloadName})`, terminal, payload.expectedByteCount);
      } finally {
        terminal.dispose();
        await cleanupTempDir(tempDir);
      }
    });
    }
    }
  }
});