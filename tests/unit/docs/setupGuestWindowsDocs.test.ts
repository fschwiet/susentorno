import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerSetupGuestWindows } from '../../../src/commands/setupGuestWindows';
import { DEFAULT_NAT_ADAPTER } from '../../../src/runHosting/forwarder';
import {
  DEFAULT_WINDOWS_SHARE_ACCOUNT,
  DEFAULT_WINDOWS_SHARE_NAME,
} from '../../../src/guestSetup/windows/setupAnswers';
import {
  HEARTBEAT_INTERVAL_MS,
  POWERSHELL_DIRECT_READY_DEADLINE_MS,
  WINDOWS_OFF_CONFIRM_TIMEOUT_MS,
  WINDOWS_STOP_TIMEOUT_MS,
  describePhase,
  type WindowsSetupPhase,
} from '../../../src/guestSetup/windows/setupFlow';
import {
  MINIMUM_SUPPORTED_WINGET_VERSION,
  PENDING_REBOOT_REMEDIATION,
  SUPPORTED_GUEST_PLATFORMS,
} from '../../../src/guestSetup/windows/guestChecks';
import { ISOLATED_READINESS_DEADLINE_MS } from '../../../src/guestSetup/windows/isolatedReadiness';
import { SHARE_OPERATION_TIMEOUT_MS } from '../../../src/guestSetup/windows/shareCredential';
import { WINDOWS_STEP_TIMEOUT_MS } from '../../../src/guestSetup/windows/stepRunner';
import { CANCELLED_EXIT_CODE, CLEANUP_DEADLINE_MS } from '../../../src/guestSetup/windows/interruptHandler';
import { formatResidualStateFooter } from '../../../src/guestSetup/windows/residualStateFooter';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const setupGuest = read('setup-guest.md');

/** The Windows part of setup-guest.md: from its heading to the next shared section. */
const windowsSection = setupGuest.slice(
  setupGuest.indexOf('### Windows guest'),
  setupGuest.indexOf('### If a guest comes up with no address'),
);

const minutes = (ms: number): string => `${ms / 60_000} minutes`;

describe('setup-guest.md Windows section matches setup-guest-windows', () => {
  const program = new Command();
  registerSetupGuestWindows(program);
  const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-windows')!;

  it('has a Windows section to check', () => {
    expect(windowsSection.length).toBeGreaterThan(1000);
  });

  it('documents every option the command registers', () => {
    expect(command.options.length).toBeGreaterThan(0);
    for (const option of command.options) {
      const long = option.long!;
      expect(windowsSection, long).toContain(`\`${long} <`);
    }
  });

  it('documents the defaults the command uses', () => {
    expect(windowsSection).toContain(`\`${DEFAULT_NAT_ADAPTER}\``);
    expect(windowsSection).toContain(`\`${DEFAULT_WINDOWS_SHARE_NAME}\``);
    expect(windowsSection).toContain(`\`${DEFAULT_WINDOWS_SHARE_ACCOUNT}\``);
    const isolationDefault = command.options.find((o) => o.long === '--isolation-name')!;
    expect(isolationDefault.defaultValue).toBeUndefined();
    expect(windowsSection).toContain('`susentorno-internal`');
  });

  it('says password flags are rejected and there is no guest-address option', () => {
    const flags = command.options.map((o) => o.long);
    expect(flags).not.toContain('--guest-password');
    expect(flags).not.toContain('--share-password');
    expect(flags).not.toContain('--guest-address');
    expect(windowsSection).toContain('`--guest-password` and `--share-password` are rejected');
    expect(windowsSection).toContain('There is no guest-address option');
  });

  it('lists the prompts in the order the flow asks them', () => {
    const asked = [
      'Hyper-V VM name',
      'SMB share name',
      'Guest username',
      'Guest password',
      'VM share account',
      'VM share password',
    ];
    const sources = [
      read('src/guestSetup/windows/setupAnswers.ts'),
      read('src/guestSetup/windows/setupFlow.ts'),
    ].join('\n');
    let from = windowsSection.indexOf('**Prompt order:**');
    expect(from).toBeGreaterThan(-1);
    for (const question of asked) {
      expect(sources, `${question} is asked by the flow`).toContain(`'${question}'`);
      const at = windowsSection.indexOf(`\`${question}\``, from);
      expect(at, `${question} is documented in order`).toBeGreaterThan(-1);
      from = at;
    }
    expect(windowsSection).toContain('(masked)');
  });

  it('lists every phase the flow announces', () => {
    const phases: WindowsSetupPhase[] = [
      'H1', 'H2', 'H3', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6',
      'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14',
    ];
    for (const phase of phases) {
      expect(describePhase(phase), phase).toMatch(new RegExp(`^${phase} `));
      expect(windowsSection, phase).toMatch(new RegExp(`\\| ${phase}\\s+\\|`));
    }
  });

  it('states the fixed limits, the platform, and the exit codes', () => {
    expect(windowsSection).toContain(`readiness ${minutes(POWERSHELL_DIRECT_READY_DEADLINE_MS)}`);
    expect(windowsSection).toContain(`each step ${minutes(WINDOWS_STEP_TIMEOUT_MS)}`);
    expect(windowsSection).toContain(`readiness ${minutes(ISOLATED_READINESS_DEADLINE_MS)}`);
    expect(windowsSection).toContain(`each share operation ${SHARE_OPERATION_TIMEOUT_MS / 60_000} minute`);
    expect(windowsSection).toContain(`about ${minutes(WINDOWS_STOP_TIMEOUT_MS)}`);
    expect(windowsSection).toContain(`${WINDOWS_OFF_CONFIRM_TIMEOUT_MS / 1000} seconds to confirm`);
    expect(windowsSection).toContain(`about every ${HEARTBEAT_INTERVAL_MS / 1000} seconds`);
    expect(windowsSection).toContain(`about ${CLEANUP_DEADLINE_MS / 1000} seconds`);
    expect(windowsSection).toContain(`\`${CANCELLED_EXIT_CODE}\``);
    expect(windowsSection).toContain(`version ${MINIMUM_SUPPORTED_WINGET_VERSION}`);
    for (const platform of SUPPORTED_GUEST_PLATFORMS) {
      expect(windowsSection).toContain(
        `${platform.product} ${platform.edition}, ${platform.architecture}, release ${platform.release}`,
      );
    }
  });

  it('shows the residual-state footer the command prints', () => {
    const footer = formatResidualStateFooter({
      outcome: 'failure',
      phase: describePhase('G13'),
      stepFilename: '99-fail.ps1',
      vmName: 'dev-vm',
      vm: { known: true, powerState: 'Running', switchName: 'susentorno-internal' },
      credentials: [
        { role: 'default', hostIp: '172.24.32.1', status: 'verified' },
        { role: 'internal', hostIp: '192.168.67.1', status: 'verified' },
      ],
    });
    for (const line of footer) expect(windowsSection).toContain(line);
  });

  it('gives the pending-reboot remediation the command prints', () => {
    expect(windowsSection.toLowerCase()).toContain(
      PENDING_REBOOT_REMEDIATION.toLowerCase().replace(/\.$/, ''),
    );
  });

  it('says a rerun is a replay and customized steps must be idempotent', () => {
    expect(windowsSection).toContain('replay from the Default Switch');
    expect(windowsSection).toContain('not a resume');
    expect(windowsSection).toContain('Customized steps must therefore be idempotent');
    expect(windowsSection).toContain('cmdkey /list');
  });
});

describe('user documentation does not send anyone to do the command\'s work by hand', () => {
  const docs = [
    ...readdirSync(repoRoot).filter((name) => name.endsWith('.md')),
    ...readdirSync(join(repoRoot, 'docs', 'adr')).map((name) => join('docs', 'adr', name)),
  ];

  it.each(docs)('%s', (path) => {
    const text = read(path);
    expect(text).not.toMatch(/Set-ExecutionPolicy/i);
    expect(text).not.toMatch(/cmdkey\s+\/(add|pass|delete)|\/pass:/i);
    expect(text).not.toMatch(/open (up )?a new (terminal|shell|powershell)/i);
    expect(text).not.toMatch(/\.\\0\d-[\w-]+\.ps1/);
  });
});
