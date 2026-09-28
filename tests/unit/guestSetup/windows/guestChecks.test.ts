import { describe, it, expect } from 'vitest';
import type {
  WindowsGuestExecutor,
  WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import { WindowsGuestError } from '../../../../src/guestSetup/windows/guestExecutor';
import {
  ADMINISTRATOR_SCRIPT,
  GuestCheckError,
  MINIMUM_SUPPORTED_WINGET_VERSION,
  PENDING_REBOOT_SCRIPT,
  PLATFORM_SCRIPT,
  STRUCTURAL_CHECK_TIMEOUT_MS,
  SUPPORTED_GUEST_PLATFORMS,
  WINGET_SCRIPT,
  checkElevatedToken,
  checkLocalAdministrator,
  checkNoPendingReboot,
  checkSupportedPlatform,
  checkWinget,
  compareVersions,
  isSupportedGuestPlatform,
  listsWingetSource,
  parseGuestPlatform,
  parseWingetVersion,
  probePendingReboot,
  runGuestStructuralChecks,
} from '../../../../src/guestSetup/windows/guestChecks';

const ok = (stdout: string): WindowsGuestResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

interface FakeGuest {
  executor: WindowsGuestExecutor;
  invocations: { script: string; timeoutMs: number }[];
}

/** Routes each invocation to a canned result by which check script it carries. */
function fakeGuest(routes: {
  platform?: WindowsGuestResult | Error;
  admin?: WindowsGuestResult | Error;
  elevation?: WindowsGuestResult | Error;
  pending?: WindowsGuestResult | Error;
  winget?: WindowsGuestResult | Error;
}): FakeGuest {
  const invocations: FakeGuest['invocations'] = [];
  const executor: WindowsGuestExecutor = {
    vmName: 'win-dev',
    async invoke(script, options) {
      invocations.push({ script, timeoutMs: options.timeoutMs });
      const route =
        script === PLATFORM_SCRIPT
          ? routes.platform
          : script === ADMINISTRATOR_SCRIPT
            ? routes.admin
            : script === PENDING_REBOOT_SCRIPT
              ? routes.pending
              : script === WINGET_SCRIPT
                ? routes.winget
                : routes.elevation;
      if (!route) throw new Error(`unexpected invocation: ${script}`);
      if (route instanceof Error) throw route;
      return route;
    },
    async dispose() {},
  };
  return { executor, invocations };
}

const goodPlatform = ok(
  JSON.stringify({
    Caption: 'Microsoft Windows 11 Enterprise Evaluation',
    Build: '26200',
    EditionId: 'EnterpriseEval',
    DisplayVersion: '25H2',
    ProcessorArchitecture: 9,
  }),
);
const goodAdmin = ok(
  JSON.stringify({ IsLocal: true, Enabled: true, IsAdministratorsMember: true }),
);
const goodElevation = ok('True\r\n');
const noReboot = ok(JSON.stringify({ Markers: [] }));
const goodWinget = ok(
  JSON.stringify({
    Found: true,
    Path: 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe',
    Version: `v${MINIMUM_SUPPORTED_WINGET_VERSION}`,
    VersionExit: 0,
    Sources:
      'Name    Argument\r\n-----------\r\nmsstore https://storeedgefd.dsx.mp.microsoft.com/v9.0\r\nwinget  https://cdn.winget.microsoft.com/cache\r\n',
    SourcesExit: 0,
  }),
);

const allGood = {
  platform: goodPlatform,
  admin: goodAdmin,
  elevation: goodElevation,
  pending: noReboot,
  winget: goodWinget,
};

function ctxFor(guest: FakeGuest) {
  return { executor: guest.executor, guestUsername: 'Administrator' };
}

async function rejection(promise: Promise<unknown>): Promise<GuestCheckError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuestCheckError);
    return error as GuestCheckError;
  }
  throw new Error('expected the check to fail');
}

describe('the supported guest platform allowlist', () => {
  it('holds Windows 11 | Enterprise | x64 | 25H2 as its only initial entry', () => {
    expect(SUPPORTED_GUEST_PLATFORMS).toEqual([
      { product: 'Windows 11', edition: 'Enterprise', architecture: 'x64', release: '25H2' },
    ]);
  });

  it('normalizes what the guest reports, treating Enterprise Evaluation as Enterprise', () => {
    expect(parseGuestPlatform(String(goodPlatform.stdout))).toEqual({
      product: 'Windows 11',
      edition: 'Enterprise',
      architecture: 'x64',
      release: '25H2',
      build: '26200',
    });
  });

  it('accepts Enterprise and Enterprise Evaluation at any build of the release', () => {
    for (const editionId of ['Enterprise', 'EnterpriseEval']) {
      const platform = parseGuestPlatform(
        JSON.stringify({
          Caption: 'Microsoft Windows 11 Enterprise',
          Build: '26200.9999',
          EditionId: editionId,
          DisplayVersion: '25H2',
          ProcessorArchitecture: 9,
        }),
      )!;
      expect(isSupportedGuestPlatform(platform), editionId).toBe(true);
    }
  });

  it.each([
    ['Windows 10', { Caption: 'Microsoft Windows 10 Enterprise', Build: '19045' }],
    ['Windows Server', { Caption: 'Microsoft Windows Server 2025 Standard' }],
    ['another edition', { EditionId: 'Professional' }],
    ['another architecture', { ProcessorArchitecture: 12 }],
    ['another release', { DisplayVersion: '24H2' }],
  ])('rejects %s', (_label, override) => {
    const platform = parseGuestPlatform(
      JSON.stringify({
        Caption: 'Microsoft Windows 11 Enterprise Evaluation',
        Build: '26200',
        EditionId: 'EnterpriseEval',
        DisplayVersion: '25H2',
        ProcessorArchitecture: 9,
        ...override,
      }),
    )!;
    expect(isSupportedGuestPlatform(platform)).toBe(false);
  });

  it('returns null for output that is not a JSON object', () => {
    expect(parseGuestPlatform('nope')).toBeNull();
    expect(parseGuestPlatform('[]')).toBeNull();
  });

  it('fails an unsupported platform naming the VM, what it runs, what is supported, and the fix', async () => {
    const guest = fakeGuest({
      platform: ok(
        JSON.stringify({
          Caption: 'Microsoft Windows 11 Pro',
          Build: '26100',
          EditionId: 'Professional',
          DisplayVersion: '24H2',
          ProcessorArchitecture: 9,
        }),
      ),
    });
    const error = await rejection(checkSupportedPlatform(ctxFor(guest)));
    expect(error.check).toBe('platform');
    expect(error.message).toContain("'win-dev'");
    expect(error.message).toContain('Windows 11 | Professional | x64 | 24H2');
    expect(error.message).toContain('build 26100');
    expect(error.message).toContain('Windows 11 | Enterprise | x64 | 25H2');
    expect(error.message).toMatch(/rerun/);
  });

  it('accepts a supported platform and reports it', async () => {
    const guest = fakeGuest({ platform: goodPlatform });
    expect(await checkSupportedPlatform(ctxFor(guest))).toMatchObject({
      product: 'Windows 11',
      release: '25H2',
    });
  });
});

describe('the local administrator check', () => {
  it('passes for an enabled local administrator', async () => {
    await checkLocalAdministrator(ctxFor(fakeGuest({ admin: goodAdmin })));
  });

  it.each([
    [
      'not a local account',
      { IsLocal: false, Enabled: false, IsAdministratorsMember: false },
      /not a local account/,
    ],
    ['disabled', { IsLocal: true, Enabled: false, IsAdministratorsMember: true }, /disabled/],
    [
      'not an administrator',
      { IsLocal: true, Enabled: true, IsAdministratorsMember: false },
      /not a member of the local Administrators group/,
    ],
  ])('fails when the account is %s, naming account and VM', async (_label, fields, pattern) => {
    const guest = fakeGuest({ admin: ok(JSON.stringify(fields)) });
    const error = await rejection(checkLocalAdministrator(ctxFor(guest)));
    expect(error.check).toBe('administrator');
    expect(error.message).toContain("'Administrator'");
    expect(error.message).toContain("'win-dev'");
    expect(error.message).toMatch(pattern);
  });
});

describe('the elevated token check', () => {
  it('passes when the token is elevated', async () => {
    await checkElevatedToken(ctxFor(fakeGuest({ elevation: goodElevation })));
  });

  it('fails when it is not, naming the account and VM', async () => {
    const error = await rejection(
      checkElevatedToken(ctxFor(fakeGuest({ elevation: ok('False') }))),
    );
    expect(error.check).toBe('elevation');
    expect(error.message).toContain("'Administrator'");
    expect(error.message).toContain("'win-dev'");
  });
});

describe('the pending-reboot probe', () => {
  it('reports no pending reboot when no standard marker exists', async () => {
    const guest = fakeGuest({ pending: noReboot });
    expect(await probePendingReboot(ctxFor(guest))).toEqual({ pending: false, markers: [] });
  });

  it('reports every standard marker found, including a lone one serialized as a string', async () => {
    const many = fakeGuest({
      pending: ok(JSON.stringify({ Markers: ['Windows Update\\RebootRequired', 'X'] })),
    });
    expect(await probePendingReboot(ctxFor(many))).toEqual({
      pending: true,
      markers: ['Windows Update\\RebootRequired', 'X'],
    });
    const lone = fakeGuest({ pending: ok(JSON.stringify({ Markers: 'X' })) });
    expect(await probePendingReboot(ctxFor(lone))).toEqual({ pending: true, markers: ['X'] });
  });

  it('can be used by a later phase without a guest username', async () => {
    const guest = fakeGuest({ pending: noReboot });
    expect(await probePendingReboot({ executor: guest.executor })).toEqual({
      pending: false,
      markers: [],
    });
  });

  it('checks the standard markers: servicing, Windows Update, pending renames', () => {
    expect(PENDING_REBOOT_SCRIPT).toContain('Component Based Servicing\\RebootPending');
    expect(PENDING_REBOOT_SCRIPT).toContain('WindowsUpdate\\Auto Update\\RebootRequired');
    expect(PENDING_REBOOT_SCRIPT).toContain('PendingFileRenameOperations');
  });

  it('never treats a failed probe as no reboot', async () => {
    const guest = fakeGuest({
      pending: { exitCode: 1, stdout: '', stderr: 'access denied', timedOut: false },
    });
    const error = await rejection(probePendingReboot(ctxFor(guest)));
    expect(error.check).toBe('pending-reboot');
    expect(error.message).toContain('access denied');
  });

  it('fails a pending reboot with the restart-then-rerun remediation', async () => {
    const guest = fakeGuest({
      pending: ok(JSON.stringify({ Markers: ['Component Based Servicing\\RebootPending'] })),
    });
    const error = await rejection(checkNoPendingReboot(ctxFor(guest)));
    expect(error.check).toBe('pending-reboot');
    expect(error.message).toContain("'win-dev'");
    expect(error.message).toContain('Component Based Servicing\\RebootPending');
    expect(error.message).toContain('Restart the guest, then rerun.');
  });
});

describe('the WinGet check', () => {
  it('parses versions with or without a leading v and compares them numerically', () => {
    expect(parseWingetVersion('v1.6.10121')).toEqual([1, 6, 10121]);
    expect(parseWingetVersion(' 1.12.470\r\n')).toEqual([1, 12, 470]);
    expect(parseWingetVersion('winget 1.6')).toBeNull();
    expect(compareVersions([1, 12, 470], [1, 6, 10121])).toBe(1);
    expect(compareVersions([1, 6, 10121], [1, 6, 10121])).toBe(0);
    expect(compareVersions([1, 6], [1, 6, 1])).toBe(-1);
  });

  it('recognizes the winget source in `winget source list` output', () => {
    expect(
      listsWingetSource(
        'Name    Argument\r\n---\r\nwinget  https://cdn.winget.microsoft.com/cache\r\n',
      ),
    ).toBe(true);
    expect(listsWingetSource('Name    Argument\r\n---\r\nmsstore https://store\r\n')).toBe(false);
    expect(listsWingetSource('')).toBe(false);
  });

  it('accepts the pinned version, and a newer one, with a usable source', async () => {
    const report = await checkWinget(ctxFor(fakeGuest({ winget: goodWinget })));
    expect(report.version).toBe(`v${MINIMUM_SUPPORTED_WINGET_VERSION}`);
    const newer = JSON.parse(String(goodWinget.stdout)) as Record<string, unknown>;
    newer.Version = 'v9.0.0';
    await checkWinget(ctxFor(fakeGuest({ winget: ok(JSON.stringify(newer)) })));
  });

  const winget = (override: Record<string, unknown>) =>
    ok(JSON.stringify({ ...JSON.parse(String(goodWinget.stdout)), ...override }));

  it.each([
    ['is not found', ok(JSON.stringify({ Found: false })), /was not found/],
    ['fails its version command', winget({ VersionExit: 1, Version: 'boom' }), /--version' failed/],
    ['reports an unreadable version', winget({ Version: 'garbage' }), /could not read/],
    ['is older than the pin', winget({ Version: 'v1.5.0' }), /older than the supported/],
    [
      'has no winget source',
      winget({ Sources: 'Name Argument\r\nmsstore https://x' }),
      /no usable 'winget' source/,
    ],
    ['fails its source list', winget({ SourcesExit: 1 }), /no usable 'winget' source/],
  ])('fails when WinGet %s, naming the VM and a remediation', async (_label, result, pattern) => {
    const error = await rejection(checkWinget(ctxFor(fakeGuest({ winget: result }))));
    expect(error.check).toBe('winget');
    expect(error.message).toContain("'win-dev'");
    expect(error.message).toMatch(pattern);
    expect(error.message).toMatch(/rerun/);
  });
});

describe('invoking a check script', () => {
  it('gives every structural check invocation a 2 minute deadline', async () => {
    const guest = fakeGuest(allGood);
    await runGuestStructuralChecks(ctxFor(guest));
    expect(guest.invocations).toHaveLength(5);
    for (const invocation of guest.invocations) {
      expect(invocation.timeoutMs).toBe(120_000);
    }
    expect(STRUCTURAL_CHECK_TIMEOUT_MS).toBe(120_000);
  });

  it('reports an in-guest timeout as a structural failure naming the check', async () => {
    const guest = fakeGuest({
      platform: { exitCode: 124, stdout: '', stderr: '', timedOut: true },
    });
    const error = await rejection(checkSupportedPlatform(ctxFor(guest)));
    expect(error.message).toContain('did not finish within 2 minutes');
    expect(error.message).toContain("'win-dev'");
  });

  it('reports a nonzero exit with bounded stderr', async () => {
    const guest = fakeGuest({
      platform: { exitCode: 1, stdout: '', stderr: 'x'.repeat(5000), timedOut: false },
    });
    const error = await rejection(checkSupportedPlatform(ctxFor(guest)));
    expect(error.message).toContain('exit 1');
    expect(error.message.length).toBeLessThan(1000);
  });

  it('reports output it cannot read', async () => {
    const guest = fakeGuest({ admin: ok('not json') });
    const error = await rejection(checkLocalAdministrator(ctxFor(guest)));
    expect(error.message).toContain('could not read');
  });

  it('lets a transport or cancellation failure from the executor propagate untouched', async () => {
    const transport = new WindowsGuestError('transport', 'the guest went away');
    const guest = fakeGuest({ platform: transport });
    await expect(checkSupportedPlatform(ctxFor(guest))).rejects.toBe(transport);
  });
});

describe('runGuestStructuralChecks', () => {
  it('runs platform, administrator, elevation, pending reboot, then WinGet, and reports the platform', async () => {
    const guest = fakeGuest(allGood);
    const report = await runGuestStructuralChecks(ctxFor(guest));
    expect(report.platform.release).toBe('25H2');
    expect(report.winget.version).toBe(`v${MINIMUM_SUPPORTED_WINGET_VERSION}`);
    expect(guest.invocations.map((i) => i.script)).toEqual([
      PLATFORM_SCRIPT,
      ADMINISTRATOR_SCRIPT,
      expect.stringContaining('IsInRole'),
      PENDING_REBOOT_SCRIPT,
      WINGET_SCRIPT,
    ]);
  });

  it('stops at the first failing check', async () => {
    const guest = fakeGuest({
      ...allGood,
      admin: ok(JSON.stringify({ IsLocal: true, Enabled: true, IsAdministratorsMember: false })),
    });
    const error = await rejection(runGuestStructuralChecks(ctxFor(guest)));
    expect(error.check).toBe('administrator');
    expect(guest.invocations).toHaveLength(2);
  });
});
