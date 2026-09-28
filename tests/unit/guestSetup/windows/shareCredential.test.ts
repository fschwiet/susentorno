import { describe, it, expect } from 'vitest';
import type {
  WindowsGuestExecutor,
  WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import {
  SHARE_CLEANUP_TIMEOUT_MS,
  SHARE_OPERATION_TIMEOUT_MS,
  ShareCredentialError,
  ShareCredentialLedger,
  buildCleanupScript,
  buildCloseScript,
  buildReplaceScript,
  buildVerifyScript,
  checkHostShareAccount,
  createVmShareCredentials,
  type ShareCredentialTarget,
} from '../../../../src/guestSetup/windows/shareCredential';

const PASSWORD = 'S3cret pw\'"$x`';
const SHARE = 'vm-shared-windows';
const DEFAULT: ShareCredentialTarget = { role: 'default', hostIp: '172.29.240.1' };
const INTERNAL: ShareCredentialTarget = { role: 'internal', hostIp: '192.168.67.1' };
const SECRET = { account: 'susentorno', password: PASSWORD };

const ok = (verdict: object = { Outcome: 'ok' }): WindowsGuestResult => ({
  exitCode: 0,
  stdout: JSON.stringify(verdict),
  stderr: '',
  timedOut: false,
});

const operationOf = (script: string): string =>
  /^# susentorno share credential: (\w+)/.exec(script)![1];

interface FakeGuest {
  executor: WindowsGuestExecutor;
  calls: { operation: string; script: string; timeoutMs: number; signal?: AbortSignal }[];
}

/** A guest that answers each share script by operation; anything not overridden succeeds. */
function fakeGuest(
  answers: Partial<Record<string, (script: string) => WindowsGuestResult | Error>> = {},
): FakeGuest {
  const calls: FakeGuest['calls'] = [];
  return {
    calls,
    executor: {
      vmName: 'win-dev',
      async invoke(script, options) {
        const operation = operationOf(script);
        calls.push({ operation, script, timeoutMs: options.timeoutMs, signal: options.signal });
        const answer = answers[operation]?.(script);
        if (answer instanceof Error) throw answer;
        if (answer) return answer;
        if (operation === 'cleanup') {
          const hostIps = [...script.matchAll(/HostIp = '([^']+)'/g)].map((m) => m[1]);
          return ok({ Results: hostIps.map((HostIp) => ({ HostIp, Outcome: 'ok' })) });
        }
        return ok();
      },
      async dispose() {},
    },
  };
}

const verifyFailure =
  (Stage: string, Win32: number, Message = 'boom'): (() => WindowsGuestResult) =>
  () =>
    ok({ Outcome: 'error', Stage, Win32, Message });

async function failureOf(promise: Promise<unknown>): Promise<ShareCredentialError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ShareCredentialError);
    return error as ShareCredentialError;
  }
  throw new Error('expected a ShareCredentialError');
}

describe('the generated guest scripts never carry the share password in a process argument', () => {
  const replace = buildReplaceScript(DEFAULT, SHARE, SECRET);

  it('does not launch cmdkey, net use, or any drive mapping, and has no /pass: argument', () => {
    for (const script of [
      replace,
      buildVerifyScript(DEFAULT, SHARE),
      buildCloseScript(DEFAULT, SHARE),
      buildCleanupScript([{ target: DEFAULT, removeCredential: true }], SHARE),
    ]) {
      expect(script).not.toMatch(/cmdkey/i);
      expect(script).not.toMatch(/\/pass:/i);
      expect(script).not.toMatch(/\bnet(\.exe)?\s+use\b/i);
      expect(script).not.toMatch(/New-PSDrive|New-SmbMapping|Start-Process|-ArgumentList/i);
    }
  });

  it('writes through the native Credential Manager API and never spawns a process', () => {
    expect(replace).toContain('CredWriteW');
    expect(replace).toContain('[SusentornoShare]::Write(');
    expect(replace).not.toMatch(/Process\.Start|ProcessStartInfo|& \$|Invoke-Expression|iex\b/);
  });

  it('carries the password only as base64 inside the request, never as plain text', () => {
    expect(replace).not.toContain(PASSWORD);
    expect(replace).toContain(Buffer.from(PASSWORD, 'utf8').toString('base64'));
  });

  it('keeps the password out of every other operation', () => {
    const base64 = Buffer.from(PASSWORD, 'utf8').toString('base64');
    for (const script of [
      buildVerifyScript(DEFAULT, SHARE),
      buildCloseScript(DEFAULT, SHARE),
      buildCleanupScript([{ target: DEFAULT, removeCredential: true }], SHARE),
    ]) {
      expect(script).not.toContain(base64);
      expect(script).not.toContain(PASSWORD);
    }
  });

  it('keys the entry by the host address and uses the UNC path with no drive letter', () => {
    expect(replace).toContain("$target = '172.29.240.1'");
    expect(replace).toContain("$unc = '\\\\' + '172.29.240.1' + '\\' + 'vm-shared-windows'");
    expect(replace).toContain("$account = 'susentorno'");
  });

  it('quotes an account name so it cannot break out of the script', () => {
    const script = buildReplaceScript(DEFAULT, SHARE, { account: "o'brien", password: 'x' });
    expect(script).toContain("$account = 'o''brien'");
  });

  it('sends the generated request to the executor, which is the only place the password goes', async () => {
    const { executor, calls } = fakeGuest();
    await createVmShareCredentials({ executor, shareName: SHARE }).replace(DEFAULT, SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0].script).not.toContain(PASSWORD);
    expect(calls[0].script).not.toMatch(/cmdkey|\/pass:/i);
  });
});

describe('replace', () => {
  it('closes the selected share, deletes the address entry, writes the new one, in that order, in one bounded request', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);

    expect(calls.map((c) => c.operation)).toEqual(['replace']);
    expect(calls[0].timeoutMs).toBe(SHARE_OPERATION_TIMEOUT_MS);
    expect(SHARE_OPERATION_TIMEOUT_MS).toBe(60_000);
    const script = calls[0].script;
    const close = script.indexOf('[SusentornoShare]::Disconnect($unc)');
    const del = script.indexOf('[SusentornoShare]::Delete($target)');
    const write = script.indexOf('[SusentornoShare]::Write($target');
    expect(close).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(close);
    expect(write).toBeGreaterThan(del);
  });

  it('records the entry as written but unverified', async () => {
    const { executor } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(INTERNAL, SECRET);
    expect(credentials.ledger.entries()).toEqual([{ ...INTERNAL, status: 'written' }]);
  });

  it('passes the caller signal so Ctrl+C can abort it', async () => {
    const { executor, calls } = fakeGuest();
    const controller = new AbortController();
    await createVmShareCredentials({
      executor,
      shareName: SHARE,
      signal: controller.signal,
    }).replace(DEFAULT, SECRET);
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('reports a failed step as an operation failure that names the address and never echoes the password', async () => {
    const { executor } = fakeGuest({
      replace: () => ok({ Outcome: 'error', Stage: 'write', Win32: 5, Message: `bad ${PASSWORD}` }),
    });
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    const error = await failureOf(credentials.replace(DEFAULT, SECRET));
    expect(error.kind).toBe('operation');
    expect(error.repromptable).toBe(false);
    expect(error.message).toContain('172.29.240.1');
    expect(error.message).toContain('write');
    expect(error.message).not.toContain(PASSWORD);
    // It may have half-written, so cleanup must still treat the entry as unverified.
    expect(credentials.ledger.entries()).toEqual([{ ...DEFAULT, status: 'written' }]);
  });

  it('redacts the password from a crashed script', async () => {
    const base64 = Buffer.from(PASSWORD, 'utf8').toString('base64');
    const { executor } = fakeGuest({
      replace: () => ({
        exitCode: 1,
        stdout: '',
        stderr: `At line:9 $password = ...('${base64}') and ${PASSWORD}`,
        timedOut: false,
      }),
    });
    const error = await failureOf(
      createVmShareCredentials({ executor, shareName: SHARE }).replace(DEFAULT, SECRET),
    );
    expect(error.message).toContain('exit 1');
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain(base64);
  });

  it('fails plainly when the request times out inside the guest', async () => {
    const { executor } = fakeGuest({
      replace: () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true }),
    });
    const error = await failureOf(
      createVmShareCredentials({ executor, shareName: SHARE }).replace(DEFAULT, SECRET),
    );
    expect(error.message).toContain('60 seconds');
  });

  it('lets a transport failure of the executor propagate untouched', async () => {
    const boom = new Error('transport down');
    const { executor } = fakeGuest({ replace: () => boom });
    await expect(
      createVmShareCredentials({ executor, shareName: SHARE }).replace(DEFAULT, SECRET),
    ).rejects.toBe(boom);
  });
});

describe('verify', () => {
  it('marks the entry verified only after the guest proves read access and a denied write', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);
    expect(credentials.ledger.entries()[0].status).toBe('written');
    await credentials.verify(DEFAULT, 'susentorno');
    expect(credentials.ledger.entries()).toEqual([{ ...DEFAULT, status: 'verified' }]);

    const verify = calls.find((c) => c.operation === 'verify')!;
    expect(verify.timeoutMs).toBe(60_000);
    // Read a known generated file, list both phase directories, and probe the share root.
    expect(verify.script).toContain('verify-config.ps1');
    expect(verify.script).toContain('pre-scripts');
    expect(verify.script).toContain('post-scripts');
    expect(verify.script).toContain('.susentorno-probe-');
    expect(verify.script).toContain('FileMode.CreateNew');
  });

  it('replaceAndVerify replaces, then verifies', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replaceAndVerify(DEFAULT, SECRET);
    expect(calls.map((c) => c.operation)).toEqual(['replace', 'verify']);
    expect(credentials.ledger.entries()[0].status).toBe('verified');
  });

  it('a writable share fails as a structural error, says the probe was removed, and is never verified', async () => {
    const { executor } = fakeGuest({
      verify: () => ok({ Outcome: 'writable', Stage: 'probe', ProbeRemoved: true }),
    });
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);
    const error = await failureOf(credentials.verify(DEFAULT, 'susentorno'));
    expect(error.kind).toBe('writable-share');
    expect(error.repromptable).toBe(false);
    expect(error.message).toContain("Account 'susentorno' can write");
    expect(error.message).toContain('probe file it created was removed');
    expect(credentials.ledger.entries()[0].status).toBe('written');
  });

  it('a writable share whose probe could not be removed tells the user which file to delete', async () => {
    const { executor } = fakeGuest({
      verify: () => ok({ Outcome: 'writable', Stage: 'probe', ProbeRemoved: false }),
    });
    const error = await failureOf(
      createVmShareCredentials({ executor, shareName: SHARE }).verify(DEFAULT, 'susentorno'),
    );
    expect(error.kind).toBe('writable-share');
    expect(error.message).toContain('.susentorno-probe-');
    expect(error.message).toContain('could not be removed');
  });

  describe('classification', () => {
    const classify = async (
      verdict: () => WindowsGuestResult,
      target: ShareCredentialTarget = DEFAULT,
    ): Promise<ShareCredentialError> => {
      const { executor } = fakeGuest({ verify: verdict });
      return failureOf(
        createVmShareCredentials({ executor, shareName: SHARE }).verify(target, 'susentorno'),
      );
    };

    it('treats a bad account or password (1326) as an authentication failure worth re-prompting', async () => {
      const error = await classify(
        verifyFailure('read', 1326, 'The user name or password is incorrect.'),
      );
      expect(error.kind).toBe('authentication');
      expect(error.repromptable).toBe(true);
      expect(error.message).toContain("account 'susentorno'");
      expect(error.message).toContain('\\\\172.29.240.1\\vm-shared-windows');
    });

    it('treats an authentication failure only at the Internal-switch address as structural', async () => {
      const error = await classify(verifyFailure('read', 1326), INTERNAL);
      expect(error.kind).toBe('internal-authentication');
      expect(error.repromptable).toBe(false);
      expect(error.message).toContain('192.168.67.1');
      expect(error.message).toContain('rerun the whole command');
    });

    it('classifies an SMB identity conflict on the same address as structural and names the address', async () => {
      const error = await classify(verifyFailure('read', 1219));
      expect(error.kind).toBe('identity-conflict');
      expect(error.repromptable).toBe(false);
      expect(error.message).toContain('172.29.240.1');
      expect(error.message).toContain('net use');
    });

    it.each([1327, 1330, 1331, 1385, 1909])(
      'classifies host account restriction %i as structural, not a wrong password',
      async (win32) => {
        const error = await classify(verifyFailure('read', win32));
        expect(error.kind).toBe('account-rejected');
        expect(error.repromptable).toBe(false);
      },
    );

    it.each([53, 67])(
      'classifies %i (path or share name not found) as a wrong share path',
      async (win32) => {
        const error = await classify(verifyFailure('read', win32));
        expect(error.kind).toBe('share-unreachable');
        expect(error.message).toContain("share 'vm-shared-windows'");
      },
    );

    it('classifies access denied after authenticating as a share permission problem', async () => {
      const error = await classify(verifyFailure('list-pre-scripts', 5));
      expect(error.kind).toBe('permission');
      expect(error.repromptable).toBe(false);
      expect(error.message).toContain('list-pre-scripts');
    });

    it.each([
      ['read', "'verify-config.ps1'"],
      ['list-pre-scripts', "'pre-scripts' directory"],
      ['list-post-scripts', "'post-scripts' directory"],
    ])('classifies missing content at %s as structural', async (stage, named) => {
      const error = await classify(verifyFailure(stage, 2));
      expect(error.kind).toBe('missing-content');
      expect(error.repromptable).toBe(false);
      expect(error.message).toContain(named);
      expect(error.message).toContain('update-shares');
    });

    it('treats an empty known file (no Windows error) as missing content', async () => {
      const error = await classify(verifyFailure('read', 0, 'verify-config.ps1 is empty'));
      expect(error.kind).toBe('missing-content');
    });

    it('falls back to an operation failure with the Windows error for anything else', async () => {
      const error = await classify(verifyFailure('probe', 32, 'sharing violation'));
      expect(error.kind).toBe('operation');
      expect(error.message).toContain('Windows error 32');
      expect(error.message).toContain('probe');
    });

    it('rejects output it cannot read', async () => {
      const { executor } = fakeGuest({
        verify: () => ({ exitCode: 0, stdout: 'not json', stderr: '', timedOut: false }),
      });
      const error = await failureOf(
        createVmShareCredentials({ executor, shareName: SHARE }).verify(DEFAULT, 'susentorno'),
      );
      expect(error.kind).toBe('operation');
      expect(error.message).toContain('could not read');
    });
  });
});

describe('close', () => {
  it('closes only the selected share connection and keeps the verified entry', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replaceAndVerify(DEFAULT, SECRET);
    expect(credentials.ledger.openConnections()).toEqual(['172.29.240.1']);

    await credentials.close(DEFAULT);
    const close = calls.find((c) => c.operation === 'close')!;
    expect(close.script).toContain("$unc = '\\\\' + '172.29.240.1' + '\\' + 'vm-shared-windows'");
    expect(close.script).not.toContain('[SusentornoShare]::Delete');
    expect(credentials.ledger.openConnections()).toEqual([]);
    expect(credentials.ledger.entries()).toEqual([{ ...DEFAULT, status: 'verified' }]);
  });

  it('fails when the connection cannot be closed', async () => {
    const { executor } = fakeGuest({
      close: () => ok({ Outcome: 'error', Stage: 'close', Win32: 5, Message: 'denied' }),
    });
    const error = await failureOf(
      createVmShareCredentials({ executor, shareName: SHARE }).close(DEFAULT),
    );
    expect(error.kind).toBe('operation');
  });
});

describe('cleanup (remove unverified)', () => {
  it('removes an entry that was written but never verified and closes its connection', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(INTERNAL, SECRET);
    await credentials.cleanup();

    const cleanup = calls.find((c) => c.operation === 'cleanup')!;
    expect(cleanup.timeoutMs).toBe(SHARE_CLEANUP_TIMEOUT_MS);
    expect(SHARE_CLEANUP_TIMEOUT_MS).toBe(30_000);
    expect(cleanup.script).toContain("HostIp = '192.168.67.1'");
    expect(cleanup.script).toContain('Delete = $true');
    expect(credentials.ledger.entries()).toEqual([{ ...INTERNAL, status: 'removed' }]);
  });

  it('keeps verified entries, only closing an open connection to them', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replaceAndVerify(DEFAULT, SECRET);
    await credentials.replace(INTERNAL, SECRET);
    await credentials.cleanup();

    const cleanup = calls.find((c) => c.operation === 'cleanup')!;
    expect(cleanup.script).toContain("HostIp = '172.29.240.1'; Unc = ");
    expect(cleanup.script).toMatch(/HostIp = '172\.29\.240\.1'[^@]*Delete = \$false/);
    expect(cleanup.script).toMatch(/HostIp = '192\.168\.67\.1'[^@]*Delete = \$true/);
    expect(credentials.ledger.entries()).toEqual([
      { ...DEFAULT, status: 'verified' },
      { ...INTERNAL, status: 'removed' },
    ]);
    expect(credentials.ledger.openConnections()).toEqual([]);
  });

  it('does nothing, and does not touch the guest, when there is nothing to clean up', async () => {
    const { executor, calls } = fakeGuest();
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replaceAndVerify(DEFAULT, SECRET);
    await credentials.close(DEFAULT);
    calls.length = 0;
    await credentials.cleanup();
    expect(calls).toEqual([]);
  });

  it('does not pass the flow signal, so cleanup still runs after Ctrl+C', async () => {
    const { executor, calls } = fakeGuest();
    const controller = new AbortController();
    const credentials = createVmShareCredentials({
      executor,
      shareName: SHARE,
      signal: controller.signal,
    });
    await credentials.replace(DEFAULT, SECRET);
    controller.abort();
    await credentials.cleanup();
    expect(calls.find((c) => c.operation === 'cleanup')!.signal).toBeUndefined();
  });

  it('records a failed removal instead of throwing when the guest cannot be reached', async () => {
    const { executor } = fakeGuest({ cleanup: () => new Error('transport down') });
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);
    await expect(credentials.cleanup()).resolves.toBeUndefined();
    expect(credentials.ledger.entries()).toEqual([{ ...DEFAULT, status: 'removal-failed' }]);
  });

  it('records a failed removal for the address whose delete failed', async () => {
    const { executor } = fakeGuest({
      cleanup: () =>
        ok({
          Results: [
            { HostIp: '172.29.240.1', Outcome: 'error', Stage: 'delete', Win32: 5, Message: 'x' },
          ],
        }),
    });
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);
    await credentials.cleanup();
    expect(credentials.ledger.entries()).toEqual([{ ...DEFAULT, status: 'removal-failed' }]);
  });

  it('a connection opened by a failed verification is closed even though the entry was removed', async () => {
    const { executor } = fakeGuest({ verify: verifyFailure('read', 1326) });
    const credentials = createVmShareCredentials({ executor, shareName: SHARE });
    await credentials.replace(DEFAULT, SECRET);
    await failureOf(credentials.verify(DEFAULT, 'susentorno'));
    expect(credentials.ledger.openConnections()).toEqual(['172.29.240.1']);
    await credentials.cleanup();
    expect(credentials.ledger.openConnections()).toEqual([]);
  });
});

describe('ShareCredentialLedger', () => {
  it('starts empty', () => {
    const ledger = new ShareCredentialLedger();
    expect(ledger.entries()).toEqual([]);
    expect(ledger.unverified()).toEqual([]);
    expect(ledger.openConnections()).toEqual([]);
  });

  it('follows written to verified, and written to removed, per address', () => {
    const ledger = new ShareCredentialLedger();
    ledger.markWritten(DEFAULT);
    ledger.markWritten(INTERNAL);
    expect(ledger.unverified().map((e) => e.hostIp)).toEqual(['172.29.240.1', '192.168.67.1']);
    ledger.markVerified(DEFAULT);
    ledger.markRemoved(INTERNAL.hostIp);
    expect(ledger.entries()).toEqual([
      { ...DEFAULT, status: 'verified' },
      { ...INTERNAL, status: 'removed' },
    ]);
    expect(ledger.unverified()).toEqual([]);
  });

  it('a replaced entry is unverified again until verified again', () => {
    const ledger = new ShareCredentialLedger();
    ledger.markWritten(DEFAULT);
    ledger.markVerified(DEFAULT);
    ledger.markWritten(DEFAULT);
    expect(ledger.entries()).toEqual([{ ...DEFAULT, status: 'written' }]);
  });

  it('returns copies, so a caller cannot rewrite history', () => {
    const ledger = new ShareCredentialLedger();
    ledger.markWritten(DEFAULT);
    ledger.entries()[0].status = 'verified';
    expect(ledger.entries()[0].status).toBe('written');
  });
});

describe('checkHostShareAccount', () => {
  const hostExec = (responses: {
    user?: string;
    access?: string;
  }): { exec: PowerShellExec; commands: string[] } => {
    const commands: string[] = [];
    return {
      commands,
      exec: {
        async run(command) {
          commands.push(command);
          if (command.startsWith('Get-LocalUser')) {
            return { exitCode: 0, stdout: responses.user ?? '' };
          }
          if (command.startsWith('Get-SmbShareAccess')) {
            return { exitCode: 0, stdout: responses.access ?? '' };
          }
          throw new Error(`unexpected host command: ${command}`);
        },
      },
    };
  };
  const user = JSON.stringify({ Name: 'susentorno', Enabled: true });
  const grant = (AccountName: string, AccessRight = 'Read', AccessControlType = 'Allow') => ({
    AccountName,
    AccessRight,
    AccessControlType,
  });

  it('passes when the local account exists, is enabled, and the share grants it read', async () => {
    const { exec } = hostExec({ user, access: JSON.stringify(grant('WIN-HOST\\susentorno')) });
    expect(await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE })).toEqual({
      ok: true,
    });
  });

  it('quotes the account and share in the host commands', async () => {
    const { exec, commands } = hostExec({ user, access: JSON.stringify(grant("H\\o'b")) });
    await checkHostShareAccount(exec, { account: "o'b", shareName: "s'h" });
    expect(commands[0]).toContain("-Name 'o''b'");
  });

  it('fails a missing account with a remediation, naming the account', async () => {
    const { exec } = hostExec({});
    const result = await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.message).toContain("'susentorno'");
      expect(result.message).toContain('New-LocalUser');
      expect(result.message).toContain('--share-account');
    }
  });

  it('ignores a wildcard match on a different account name', async () => {
    const { exec } = hostExec({
      user: JSON.stringify({ Name: 'susentorno-other', Enabled: true }),
    });
    const result = await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE });
    expect(result.ok).toBe(false);
  });

  it('fails a disabled account', async () => {
    const { exec } = hostExec({ user: JSON.stringify({ Name: 'susentorno', Enabled: false }) });
    const result = await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('disabled');
  });

  it('fails when the share does not grant the account access', async () => {
    const { exec } = hostExec({ user, access: JSON.stringify(grant('WIN-HOST\\someone-else')) });
    const result = await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(`'${SHARE}'`);
      expect(result.message).toContain('Grant-SmbShareAccess');
    }
  });

  it('does not count a Deny entry or an unknown right as read access', async () => {
    const { exec } = hostExec({
      user,
      access: JSON.stringify([
        grant('WIN-HOST\\susentorno', 'Read', 'Deny'),
        grant('WIN-HOST\\susentorno', 'None'),
      ]),
    });
    const result = await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE });
    expect(result.ok).toBe(false);
  });

  it('accepts a grant to Everyone', async () => {
    const { exec } = hostExec({ user, access: JSON.stringify(grant('Everyone', 'Change')) });
    expect(await checkHostShareAccount(exec, { account: 'susentorno', shareName: SHARE })).toEqual({
      ok: true,
    });
  });
});
