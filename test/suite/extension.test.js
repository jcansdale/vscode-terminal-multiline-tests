const assert = require('assert');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const LONG_SINGLE_LINE_LENGTH = 1050;

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

function createSingleLinePayload(textLength) {
  const line = 'a'.repeat(textLength);

  return {
    textLength,
    expectedByteCount: line.length + 1,
    command: `echo ${line} | wc -c`,
  };
}

function createPwshPayload(lineCount) {
  const expectedLines = [];
  for (let i = 1; i <= lineCount; i++) {
    expectedLines.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(51)}`);
  }

  const arrayElements = expectedLines.map(line => `"${line}"`).join('\n');

  return {
    lineCount,
    expectedByteCount: expectedLines.join('\n').length + 1,
    command: `$lines = @(\n${arrayElements}\n)\n($lines -join \"\`n\").Length + 1`,
  };
}

function createPwshSingleLinePayload(textLength) {
  const line = 'a'.repeat(textLength);

  return {
    textLength,
    expectedByteCount: line.length + 1,
    command: `("${line}").Length + 1`,
  };
}

const SEND_COUNT = 5;  // Run 5x to stress test
const OPERATION_IDLE_TIMEOUT_MS = 5000;
// On macOS we require Homebrew bash (v4+) for bracketed paste mode support.
// If Homebrew bash isn't installed, the bash tests will be skipped.
const BASH_PATH = process.env.BASH_PATH || (process.platform === 'darwin'
  ? (fsSync.existsSync('/opt/homebrew/bin/bash') ? '/opt/homebrew/bin/bash' : '/usr/local/bin/bash')
  : '/bin/bash');
const PWSH_PATH = process.env.PWSH_PATH || 'pwsh';

// These cases target the boundaries discussed in microsoft/vscode#296955:
// one long line checks whether the 1024-byte issue is newline-sensitive,
// 19 lines crosses the macOS 1024-byte canonical-input limit and 73 lines
// lands just above Linux's default 4096-byte N_TTY buffer.
const PAYLOAD_CONFIGS = [
  { name: 'single-line payload', createPayload, createPwshPayload: createPwshSingleLinePayload, size: LONG_SINGLE_LINE_LENGTH, counts: [1, SEND_COUNT] },
  { name: '19-line payload', createPayload, createPwshPayload, size: 19, counts: [1, SEND_COUNT] },
  { name: '73-line payload', createPayload, createPwshPayload, size: 73, counts: [SEND_COUNT] },
];

function getPayloadMatrix(shellPath) {
  return PAYLOAD_CONFIGS.map(({ name, createPayload, createPwshPayload, size, counts }) => ({
    name,
    payload: (isPwshShell(shellPath) ? createPwshPayload : createPayload)(size),
    counts,
  }));
}

function makeRedirectCommand(shellPath, command, filePath) {
  if (isPwshShell(shellPath)) {
    return `${command} | Out-File -FilePath "${filePath}" -Encoding ascii -NoNewline`;
  }
  return `${command} > "${filePath}"`;
}

function makeWarmupCommand(shellPath) {
  if (isPwshShell(shellPath)) {
    return 'Write-Host ready';
  }
  return 'echo ready';
}

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

function isShellAvailable(shellPath) {
  if (path.isAbsolute(shellPath)) {
    return fsSync.existsSync(shellPath);
  }
  try {
    const cmd = process.platform === 'win32' ? `where "${shellPath}"` : `which "${shellPath}"`;
    require('child_process').execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isPwshShell(shellPath) {
  const name = shellBaseName(shellPath);
  return name === 'pwsh';
}

function shellBaseName(shellPath) {
  return path.basename(shellPath).replace(/\.exe$/i, '').toLowerCase();
}

const GITBASH_PATH = process.env.GITBASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';

const shellMatrix = [];
if (process.platform !== 'win32') {
  shellMatrix.push(
    { shellPath: BASH_PATH, shellArgs: ['-i'], manual: true },
    { shellPath: '/bin/zsh', shellArgs: ['-i'], manual: true },
  );
}
if (process.platform === 'win32') {
  shellMatrix.push(
    { shellPath: GITBASH_PATH, shellArgs: ['-i'], manual: true },
    { shellPath: PWSH_PATH, shellArgs: [], manual: false },
  );
}

function getVsCodeAppRoot() {
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'app');
  }

  return path.resolve(process.execPath, '..', 'resources', 'app');
}

function getShellIntegrationScriptName(shellPath) {
  const shellName = shellBaseName(shellPath);

  if (shellName === 'bash') {
    return 'shellIntegration-bash.sh';
  }

  if (shellName === 'zsh') {
    return 'shellIntegration-rc.zsh';
  }

  throw new Error(`Unsupported shell for manual integration: ${shellPath}`);
}

function getShellIntegrationScriptPath(shellPath) {
  const scriptName = getShellIntegrationScriptName(shellPath);
  const candidatePaths = [
    path.join(getVsCodeAppRoot(), 'out', 'vs', 'workbench', 'contrib', 'terminal', 'common', 'scripts', scriptName),
  ];

  if (process.env.VSCODE_SOURCE_DIR) {
    candidatePaths.push(
      path.join(process.env.VSCODE_SOURCE_DIR, 'src', 'vs', 'workbench', 'contrib', 'terminal', 'common', 'scripts', scriptName),
      path.join(process.env.VSCODE_SOURCE_DIR, 'out', 'vs', 'workbench', 'contrib', 'terminal', 'common', 'scripts', scriptName),
    );
  }

  const scriptPath = candidatePaths.find(candidatePath => fsSync.existsSync(candidatePath));
  if (scriptPath) {
    return scriptPath;
  }

  throw new Error(`Shell integration script not found. Tried: ${candidatePaths.join(', ')}`);
}

async function createManualShellEnv(shellPath) {
  const shellName = shellBaseName(shellPath);
  const shellHome = await fs.mkdtemp(path.join(os.tmpdir(), `vscode-shell-home-${shellName}-`));
  const scriptPath = getShellIntegrationScriptPath(shellPath);

  if (shellName === 'bash') {
    await fs.writeFile(path.join(shellHome, '.bashrc'), `. "${scriptPath}"\n`, 'utf8');
    return { shellHome, env: { HOME: shellHome } };
  }

  if (shellName === 'zsh') {
    await fs.writeFile(path.join(shellHome, '.zshrc'), `. "${scriptPath}"\n`, 'utf8');
    return {
      shellHome,
      env: {
        HOME: shellHome,
        ZDOTDIR: shellHome,
        USER_ZDOTDIR: shellHome,
      },
    };
  }

  throw new Error(`Unsupported shell for manual integration: ${shellPath}`);
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

function isZshShell(shellPath) {
  return shellBaseName(shellPath) === 'zsh';
}

function getShellIntegrationTimeout(shellPath) {
  if (isZshShell(shellPath)) {
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

  if (isZshShell(shellPath)) {
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

function createTerminal(name, shellPath, shellArgs, env) {
  return vscode.window.createTerminal({
    name,
    shellPath,
    shellArgs,
    env,
  });
}

async function warmupShellIntegration(shell) {
  if (!isShellAvailable(shell.shellPath)) {
    return;
  }

  const shellName = shellBaseName(shell.shellPath);
  let env = {};
  let shellHome;

  if (shell.manual) {
    const manualEnv = await createManualShellEnv(shell.shellPath);
    env = manualEnv.env;
    shellHome = manualEnv.shellHome;
  }

  const label = shell.manual ? 'manual' : 'auto';
  const terminal = createTerminal(`shellIntegration warmup ${shellName} ${label}`, shell.shellPath, shell.shellArgs, env);

  try {
    terminal.show(true);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const shellIntegration = await getShellIntegrationWithWarmup(terminal, shell.shellPath);
    console.log(`shell integration warmup (${shellName} ${label}): ${shellIntegration ? 'ready' : 'unavailable'}`);
  } finally {
    terminal.dispose();
    if (shellHome) {
      await cleanupTempDir(shellHome);
    }
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
    const shellLabel = shell.manual ? 'manual' : 'auto';
    const shellName = `${path.basename(shell.shellPath)} ${shellLabel}`;
    const payloadMatrix = getPayloadMatrix(shell.shellPath);

    for (const { name: payloadName, payload, counts } of payloadMatrix) {
    for (const count of counts) {
    test(`executeCommand ${count}x (${shellName}, ${payloadName})`, async function () {
      if (!isShellAvailable(shell.shellPath)) {
        this.skip();
      }
      this.timeout(120000);

      const tempDir = await createTempDir();
      let env = {};
      let shellHome;

      if (shell.manual) {
        const manualEnv = await createManualShellEnv(shell.shellPath);
        env = manualEnv.env;
        shellHome = manualEnv.shellHome;
      }

      const terminal = createTerminal(`executeCommand ${count}x ${shellName}`, shell.shellPath, shell.shellArgs, env);

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
          shellIntegration.executeCommand(makeRedirectCommand(shell.shellPath, payload.command, filePath));
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
        if (shellHome) {
          await cleanupTempDir(shellHome);
        }
      }
    })

    test(`sendText ${count}x (${shellName}, ${payloadName})`, async function () {
      if (!isShellAvailable(shell.shellPath)) {
        this.skip();
      }
      this.timeout(120000);

      const tempDir = await createTempDir();
      let env = {};
      let shellHome;

      if (shell.manual) {
        const manualEnv = await createManualShellEnv(shell.shellPath);
        env = manualEnv.env;
        shellHome = manualEnv.shellHome;
      }

      const terminal = createTerminal(`sendText ${count}x ${shellName}`, shell.shellPath, shell.shellArgs, env);

      try {
        terminal.show(true);

        // Wait for shell to be ready before sending text
        await new Promise(resolve => setTimeout(resolve, 1000));

        const shellIntegration = await getShellIntegrationWithWarmup(terminal, shell.shellPath);
        
        // Warm-up command
        const warmupCmd = makeWarmupCommand(shell.shellPath);
        if (shellIntegration) {
          const warmupCompletion = waitForCommandCompletion(terminal, 5000);
          terminal.sendText(warmupCmd, true);
          await warmupCompletion;
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          terminal.sendText(warmupCmd, true);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const outputs = [];
        for (let i = 1; i <= count; i++) {
          const filePath = path.join(tempDir, `output-${i}.txt`);
          const completionPromise = shellIntegration
            ? waitForCommandCompletion(terminal, OPERATION_IDLE_TIMEOUT_MS)
            : null;
          
          terminal.sendText(makeRedirectCommand(shell.shellPath, payload.command, filePath), true);
          
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
        if (shellHome) {
          await cleanupTempDir(shellHome);
        }
      }
    });
    }
    }
  }
});