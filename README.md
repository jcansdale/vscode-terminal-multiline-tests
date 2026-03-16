# VS Code Terminal Multiline Tests

Integration tests that reproduce an issue where multiline commands sent to the VS Code terminal via `sendText` or `executeCommand` produce corrupted output when the command exceeds 1024 bytes.

## The Problem

When a multiline command (containing literal newlines) exceeds 1024 bytes, content after byte 1024 is corrupted — replaying earlier buffer content. The closing quote/delimiter is typically lost, leaving the shell stuck.

Key observations:
- Single-line commands of any length work fine
- Multiline commands ≤ 1023 bytes work fine
- Multiline commands ≥ 1024 bytes corrupt at exactly byte 1024

## Test Cases

The tests send a multiline `echo` command (~1064 bytes) through a pipe to `wc -c` and verify the output matches the expected byte count.

- **`executeCommand twice`** — sends the command twice using `shellIntegration.executeCommand()`
- **`sendText twice`** — sends the command twice using `terminal.sendText()`

## Running

### Against a stable VS Code build

```sh
npm install
npm test
```

### Against a local Code OSS build

Set `VSCODE_PATH` to point at your Code OSS executable:

```sh
VSCODE_PATH=/path/to/code-oss npm test
```

## License

[MIT](LICENSE)
