import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface NamedSecret {
  /** How a finding refers to it; the value itself never appears in a finding. */
  name: string;
  value: string;
}

/**
 * Both the UTF-8 and the UTF-16LE encodings, since Windows tools write either.
 * A finding names the file and the secret, never the secret's value.
 */
export function scanTextForSecrets(
  label: string,
  content: string | Buffer,
  secrets: readonly NamedSecret[],
): string[] {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const findings: string[] = [];
  for (const secret of secrets) {
    if (secret.value === '') continue;
    const encodings: BufferEncoding[] = ['utf8', 'utf16le'];
    if (encodings.some((encoding) => buffer.includes(Buffer.from(secret.value, encoding)))) {
      findings.push(`${label} contains the ${secret.name}`);
    }
  }
  return findings;
}

/** Every file under `root`, text or binary (screenshots included). */
export function scanArtifactsForSecrets(root: string, secrets: readonly NamedSecret[]): string[] {
  if (!existsSync(root)) return [];
  const findings: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else findings.push(...scanTextForSecrets(relative(root, path), readFileSync(path), secrets));
    }
  };
  walk(root);
  return findings;
}

/** The shipped steps whose outcome decides whether a controlled reboot is ever needed. */
export const REBOOT_EVIDENCE_STEPS = [
  '01-install-packages.ps1',
  '02-install-pnpm.ps1',
  '03-install-tools.ps1',
] as const;

export type RebootProbeEvidence = { pending: boolean; markers: string[] } | { error: string };

export interface RebootEvidenceInput {
  run: number;
  exitCode: number;
  /** The command's combined output for this run. */
  log: string;
  pendingReboot: RebootProbeEvidence;
}

/**
 * Installer output that asks for a reboot. WinGet's "restart your shell" notice after a PATH
 * change is about the shell, not the machine, and must not count.
 */
const REBOOT_REQUEST =
  /reboot|restart (is |may be |will be )?(required|needed)|restart (the|your) (computer|machine|device|system|guest|pc)/i;

const BOUNDARY_LINE = /^setup-guest-windows: (?:[HG]\d+ .*\.\.\.|failed in phase .*)$/;
const STEP_START_LINE = /^setup-guest-windows: G\d+ running step \S+\/(\S+) \(\d+ of \d+\)$/;

function stepOutcome(lines: string[], filename: string): { outcome: string; notes: string[] } {
  const start = lines.findIndex((line) => STEP_START_LINE.exec(line)?.[1] === filename);
  if (start === -1) return { outcome: 'not run', notes: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (BOUNDARY_LINE.test(lines[i]) || STEP_START_LINE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const failed = lines.some((line) => line.includes(`at step ${filename}`));
  const finished = end < lines.length && !failed;
  const notes = lines.slice(start + 1, end).filter((line) => REBOOT_REQUEST.test(line));
  return { outcome: failed ? 'failed' : finished ? 'completed' : 'incomplete', notes };
}

/**
 * `reboot-evidence.txt`: whether any supported installer asked for a reboot.
 * A green run is itself the evidence that none did (a reboot-required result
 * fails its step, and the isolation gate refuses a pending reboot); this file
 * records what was observed so a failure can be judged from data.
 */
export function formatRebootEvidence(input: RebootEvidenceInput): string {
  const lines = input.log.split(/\r?\n/);
  const probe = input.pendingReboot;
  const out = [`setup-guest-windows run ${input.run}: exit code ${input.exitCode}`];
  if ('error' in probe) {
    out.push(`pending-reboot probe: could not run (${probe.error})`);
  } else if (probe.pending) {
    out.push(`pending-reboot probe: PENDING (${probe.markers.join(', ')})`);
  } else {
    out.push('pending-reboot probe: none');
  }
  for (const filename of REBOOT_EVIDENCE_STEPS) {
    const { outcome, notes } = stepOutcome(lines, filename);
    out.push(`${filename}: ${outcome}`);
    for (const note of notes) out.push(`  reboot-related output: ${note.trim()}`);
  }
  out.push('');
  return out.join('\n');
}

export const GH_SHIM_DIRECTORY = 'C:\\susentorno-test-shims';

/**
 * The single remaining test substitution (ADR-0027): a `gh.cmd` that exits 0
 * for any arguments, in a directory at the front of the guest's MACHINE path.
 * The machine path is used deliberately: each step starts in a fresh process
 * that reads persisted environment, and ticket 09 forbids runner-supplied PATH
 * behavior. The real GitHub.cli package is still installed by step 01; the shim
 * only shadows it. It lives on the disposable differencing disk, and
 * sweepIsolationResidue removes that disk after an aborted run.
 */
export function buildGhShimStagingScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = '${GH_SHIM_DIRECTORY}'`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    'Set-Content -LiteralPath (Join-Path $dir \'gh.cmd\') -Value "@echo off`r`nexit /b 0" -Encoding ascii',
    "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$rest = @($machine -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $dir })",
    "[Environment]::SetEnvironmentVariable('Path', (@($dir) + $rest) -join ';', 'Machine')",
  ].join('\n');
}
