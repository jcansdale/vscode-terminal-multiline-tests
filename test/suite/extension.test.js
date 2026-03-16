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

const commandVariants = [
  {
    suffix: '| wc -c',
    command: `${ECHO_BODY} | wc -c`,
    validate(content, label) {
      const actual = parseInt(content.trim(), 10);
      if (isNaN(actual)) {
        return `${label}: expected a number, got ${JSON.stringify(content.trim())}`;
      }
      if (actual !== EXPECTED_BYTE_COUNT) {
        return `${label}: expected ${EXPECTED_BYTE_COUNT} bytes, got ${actual}`;
      }
      return null;
    },
  },
  {
    suffix: '>',
    command: ECHO_BODY,
    validate(content, label) {
      const actualLines = content.trimEnd().split('\n');
      if (actualLines.length !== EXPECTED_LINES.length) {
        return `${label}: expected ${EXPECTED_LINES.length} lines, got ${actualLines.length}`;
      }
      for (let i = 0; i < EXPECTED_LINES.length; i++) {
        if (actualLines[i] !== EXPECTED_LINES[i]) {
          return `${label}: line ${i + 1} differs:\n  expected: ${JSON.stringify(EXPECTED_LINES[i])}\n  actual:   ${JSON.stringify(actualLines[i])}`;
        }
      }
      return null;
    },
  },
];

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
  return {
    tempDir,
    first: path.join(tempDir, 'first.txt'),
    second: path.join(tempDir, 'second.txt'),
  };
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

async function assertExpectedOutput(paths, name, terminal, validate) {
  let firstOutput, secondOutput;
  try {
    firstOutput = await waitForFileText(paths.first, 7000, `first ${name}`);
  } catch (e) {
    firstOutput = '<timed out>';
  }
  try {
    secondOutput = await waitForFileText(paths.second, 7000, `second ${name}`);
  } catch (e) {
    secondOutput = '<timed out>';
  }

  const firstError = firstOutput === '<timed out>' ? 'first: timed out' : validate(firstOutput, 'first');
  const secondError = secondOutput === '<timed out>' ? 'second: timed out' : validate(secondOutput, 'second');

  let terminalText;
  try {
    terminalText = await getTerminalContents(terminal);
  } catch (e) {
    terminalText = `<failed to capture: ${e.message}>`;
  }

  const details = [
    `--- first output ---`,
    firstError || 'OK (all lines match)',
    `--- second output ---`,
    secondError || 'OK (all lines match)',
    `--- terminal contents ---`,
    terminalText,
  ].join('\n');

  console.log(`${name}:\n${details}`);

  if (firstError || secondError) {
    assert.fail(`${name} failed:\n${details}`);
  }
}

suite('Multiline terminal repro', () => {
  for (const shell of shellMatrix) {
    const shellName = path.basename(shell.shellPath);

    for (const variant of commandVariants) {
      test(`executeCommand twice ${variant.suffix} (${shellName})`, async function () {
        if (!fsSync.existsSync(shell.shellPath)) {
          this.skip();
        }
        this.timeout(20000);

        const paths = await createTempPaths();
        const terminal = createTerminal(`executeCommand ${variant.suffix} ${shellName}`, shell);

        try {
          terminal.show(true);

          const shellIntegration = await waitForShellIntegration(terminal, 3000);
          if (!shellIntegration) {
            this.skip();
          }

          shellIntegration.executeCommand(`${variant.command} > "${paths.first}"`);
          await waitForFileText(paths.first, 7000, 'first executeCommand');

          shellIntegration.executeCommand(`${variant.command} > "${paths.second}"`);
          await assertExpectedOutput(paths, `executeCommand ${variant.suffix} ${shellName}`, terminal, variant.validate);
        } finally {
          terminal.dispose();
          await cleanupTempPaths(paths);
        }
      });

      test(`sendText twice ${variant.suffix} (${shellName})`, async function () {
        if (!fsSync.existsSync(shell.shellPath)) {
          this.skip();
        }
        this.timeout(20000);

        const paths = await createTempPaths();
        const terminal = createTerminal(`sendText ${variant.suffix} ${shellName}`, shell);

        try {
          terminal.show(true);

          // Wait for shell to be ready before sending text
          await new Promise(resolve => setTimeout(resolve, 1000));

          terminal.sendText(`${variant.command} > "${paths.first}"`, true);
          await waitForFileText(paths.first, 7000, 'first sendText');

          terminal.sendText(`${variant.command} > "${paths.second}"`, true);
          await assertExpectedOutput(paths, `sendText ${variant.suffix} ${shellName}`, terminal, variant.validate);
        } finally {
          terminal.dispose();
          await cleanupTempPaths(paths);
        }
      });
    }
  }
});