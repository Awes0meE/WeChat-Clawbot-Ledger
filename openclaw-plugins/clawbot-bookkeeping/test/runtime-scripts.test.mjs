import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptsDirectory = join(projectDirectory, 'scripts');
const configureScript = join(scriptsDirectory, 'configure-ezbookkeeping-mcp.ps1');
const installScript = join(scriptsDirectory, 'install-ezbookkeeping-task.ps1');

function runPowerShell(arguments_) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...arguments_],
    { encoding: 'utf8', windowsHide: true },
  );
}

test('runtime setup scripts parse and WhatIf leaves a UTF-8 INI untouched', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-scripts-'));
  try {
    const configPath = join(temporaryDirectory, 'ezbookkeeping.ini');
    const apiTokenPath = join(temporaryDirectory, 'api-token.txt');
    const mcpTokenPath = join(temporaryDirectory, 'secrets', 'mcp-token.txt');
    const originalIni = '[mcp]\r\nenable_mcp = false\r\nmcp_allowed_remote_ips = 10.0.0.1\r\n';
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(apiTokenPath, 'api-token-that-must-not-appear', 'utf8');

    for (const scriptPath of [configureScript, installScript]) {
      const quotedPath = scriptPath.replace(/'/g, "''");
      const output = runPowerShell([
        '-Command',
        "$tokens = $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('" + quotedPath + "', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
      ]);
      assert.equal(output.trim(), '');
    }

    const output = runPowerShell([
      '-File',
      configureScript,
      '-WhatIf',
      '-ConfigPath',
      configPath,
      '-ApiTokenPath',
      apiTokenPath,
      '-McpTokenPath',
      mcpTokenPath,
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
    assert.equal(output.includes('api-token-that-must-not-appear'), false);
    assert.equal(output.includes('mcp-token'), false);
    assert.equal(readFileSync(configPath).equals(Buffer.from(originalIni, 'utf8')), true);
    assert.throws(() => readFileSync(mcpTokenPath));
    assert.deepEqual(readdirSync(temporaryDirectory).sort(), ['api-token.txt', 'ezbookkeeping.ini']);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('runtime setup scripts keep non-mutating approval guards before secrets or registration', () => {
  const configureSource = readFileSync(configureScript, 'utf8');
  const installSource = readFileSync(installScript, 'utf8');

  for (const source of [configureSource, installSource]) {
    assert.match(source, /CmdletBinding\s*\(\s*SupportsShouldProcess/);
  }
  assert.equal([...configureSource.matchAll(/\$PSCmdlet\.ShouldProcess\(/g)].length, 1);
  assert.ok(configureSource.indexOf('if (-not $PSCmdlet.ShouldProcess(') >= 0);
  assert.ok(configureSource.indexOf('if (-not $PSCmdlet.ShouldProcess(') < configureSource.indexOf('Read-Host'));
  assert.ok(installSource.indexOf('$PSCmdlet.ShouldProcess(') < installSource.indexOf('Register-ScheduledTask'));
});
