import { execa } from 'execa';

/** Single-quoted PowerShell string literals escape an embedded quote by doubling it. */
function escapeForSingleQuotedPowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildQueryCommand(execPath: string): string {
  const escaped = escapeForSingleQuotedPowerShellString(execPath);
  return (
    'try { ' +
    'Get-NetFirewallRule -Action Block -ErrorAction Stop | Where-Object { ' +
    `$_.Name -like '*Query User*' -and $_.Name.EndsWith('${escaped}', [StringComparison]::OrdinalIgnoreCase) ` +
    '} | Select-Object -ExpandProperty Name ' +
    '} catch { Write-Error $_.Exception.Message; exit 2 }'
  );
}

/**
 * Guard (host-side, Windows only): tests/proxy-stack/mockUpstream.ts binds 0.0.0.0 so the
 * Dockerized Envoy container this suite drives can reach it. If Windows' "allow node.exe on
 * public networks?" prompt was ever dismissed/declined for the node.exe running this test
 * process, Windows writes a Block rule of the same breadth the Allow rule would have had —
 * it silently drops those inbound connections rather than raising anything in-process (a
 * bind()/listen() call succeeds either way), so the test-visible symptom is a hang or timeout
 * far from this cause. Check up front and fail fast with a message that names the fix.
 *
 * Fails closed if the query itself can't run (rather than silently skipping): a check that
 * can go quietly broken is worse than no check, since nothing else would ever surface that.
 */
export async function checkNodeNotFirewallBlocked(): Promise<void> {
  if (process.platform !== 'win32') return;

  const execPath = process.execPath;
  const result = await execa(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', buildQueryCommand(execPath)],
    {
      reject: false,
      all: true,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not query Windows Firewall state (Get-NetFirewallRule exited ${result.exitCode}):\n${result.all ?? ''}\n` +
        'This preflight check could not run, so a firewall Block rule on this node.exe cannot be ruled out. ' +
        'Investigate before trusting the rest of this test run.',
    );
  }

  const matches = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (matches.length > 0) {
    throw new Error(
      `Windows Firewall has a Block rule for this Node binary (${execPath}), left over from ` +
        'dismissing/declining its "allow on public networks" prompt -- likely during an earlier ' +
        '`pnpm test` run. tests/proxy-stack/mockUpstream.ts binds 0.0.0.0 so the Dockerized Envoy ' +
        'container this suite drives can reach it; this rule silently drops those connections, ' +
        'which will hang or time out proxy-stack tests far from this cause.\n\n' +
        'Delete it (elevated PowerShell), then re-run:\n' +
        `  Get-NetFirewallRule -Action Block | Where-Object { $_.Name -like '*Query User*' -and $_.Name.EndsWith('${escapeForSingleQuotedPowerShellString(execPath)}', [StringComparison]::OrdinalIgnoreCase) } | Remove-NetFirewallRule`,
    );
  }
}
