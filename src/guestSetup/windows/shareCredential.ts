import type { PowerShellExec } from '../powerShellExec';
import { quoteForPowerShell } from '../quoteForPowerShell';
import type { WindowsGuestExecutor } from './guestExecutor';

/** Each share replacement or verification is bounded at 1 minute. */
export const SHARE_OPERATION_TIMEOUT_MS = 60_000;
/**
 * Cleanup after a failure or Ctrl+C has to fit, together with disposing the
 * executor, inside the interrupt handler's 30 second allowance so the footer
 * still prints. First, cancelled bridges are drained (at most
 * SHARE_DRAIN_TIMEOUT_MS) so a late CredWrite cannot land after the delete;
 * then the cleanup script runs (at most SHARE_CLEANUP_TIMEOUT_MS); and the
 * whole is bounded again by SHARE_CLEANUP_BUDGET_MS.
 */
export const SHARE_DRAIN_TIMEOUT_MS = 8_000;
export const SHARE_CLEANUP_TIMEOUT_MS = 10_000;
export const SHARE_CLEANUP_BUDGET_MS = 20_000;

/**
 * A file every generated Windows VM share carries at its root
 * (templates/vm-shared-windows/verify-config.ps1). Reading it proves the guest
 * really authenticated and reached this environment's share.
 */
export const KNOWN_SHARE_FILE = 'verify-config.ps1';
/** Windows Credential Manager type CRED_TYPE_DOMAIN_PASSWORD: what `cmdkey /add:<host>` writes. */
const CRED_TYPE_DOMAIN_PASSWORD = 2;
/** CRED_PERSIST_LOCAL_MACHINE: survives logoff and reboot, like a `cmdkey /add` entry. */
const CRED_PERSIST_LOCAL_MACHINE = 2;

/**
 * Which of the two address-keyed entries: the host address the guest reaches
 * on the Default Switch, or the one on the selected Internal switch.
 */
export type ShareCredentialRole = 'default' | 'internal';

export interface ShareCredentialTarget {
  role: ShareCredentialRole;
  /** The host IPv4 address the Credential Manager entry is keyed by. */
  hostIp: string;
}

export const describeTarget = (target: ShareCredentialTarget): string =>
  `${target.role === 'default' ? 'Default Switch' : 'Internal switch'} host address ${target.hostIp}`;

// --- Ledger -------------------------------------------------------------------

/**
 * `written`: this run wrote the entry and has not verified it yet.
 * `verified`: read access was proven and the entry stays.
 * `removed`: this run removed the entry it had written but not verified.
 * `removal-failed`: setup tried to remove it and could not; it may still exist.
 */
export type ShareCredentialStatus = 'written' | 'verified' | 'removed' | 'removal-failed';

export interface ShareCredentialLedgerEntry {
  role: ShareCredentialRole;
  hostIp: string;
  status: ShareCredentialStatus;
}

/**
 * The per-run record of what this run did to the guest's VM share credentials,
 * plus which selected-share connections it may have left open. The footer
 * reports it and cleanup is driven by it.
 */
export class ShareCredentialLedger {
  private readonly byAddress = new Map<string, ShareCredentialLedgerEntry>();
  private readonly open = new Set<string>();

  markWritten(target: ShareCredentialTarget): void {
    this.byAddress.set(target.hostIp, { ...target, status: 'written' });
  }

  markVerified(target: ShareCredentialTarget): void {
    this.byAddress.set(target.hostIp, { ...target, status: 'verified' });
  }

  markRemoved(hostIp: string): void {
    this.setStatus(hostIp, 'removed');
  }

  markRemovalFailed(hostIp: string): void {
    this.setStatus(hostIp, 'removal-failed');
  }

  markConnectionOpen(hostIp: string): void {
    this.open.add(hostIp);
  }

  markConnectionClosed(hostIp: string): void {
    this.open.delete(hostIp);
  }

  entries(): ShareCredentialLedgerEntry[] {
    return [...this.byAddress.values()].map((entry) => ({ ...entry }));
  }

  /** Entries this run wrote and never verified: the only ones cleanup removes. */
  unverified(): ShareCredentialLedgerEntry[] {
    return this.entries().filter((entry) => entry.status === 'written');
  }

  openConnections(): string[] {
    return [...this.open];
  }

  private setStatus(hostIp: string, status: ShareCredentialStatus): void {
    const entry = this.byAddress.get(hostIp);
    if (entry) entry.status = status;
  }
}

// --- Failures -----------------------------------------------------------------

/**
 * `authentication` is the only kind that asks for the account and password
 * again. Everything else is structural: a correct password would not help.
 */
export type ShareCredentialFailureKind =
  | 'authentication'
  | 'internal-authentication'
  | 'identity-conflict'
  | 'account-rejected'
  | 'share-unreachable'
  | 'permission'
  | 'missing-content'
  | 'writable-share'
  | 'operation';

export class ShareCredentialError extends Error {
  readonly kind: ShareCredentialFailureKind;
  readonly target: ShareCredentialTarget;

  constructor(kind: ShareCredentialFailureKind, target: ShareCredentialTarget, message: string) {
    super(message);
    this.name = 'ShareCredentialError';
    this.kind = kind;
    this.target = target;
  }

  /** Whether the flow should ask for the VM share account and password again. */
  get repromptable(): boolean {
    return this.kind === 'authentication';
  }
}

// --- Guest scripts ------------------------------------------------------------

/**
 * The native helper every share script compiles in the guest. Credentials go
 * through advapi32's CredWrite, the API `cmdkey /add` itself uses, so a password
 * never reaches a process argument. Connections are closed through mpr.dll and
 * all access is by UNC path: no drive letter, no drive mapping. Kept to C# 5
 * because Windows PowerShell 5.1's Add-Type compiles with the .NET Framework.
 */
const NATIVE_HELPER_SOURCE = `using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public class SusentornoShareResult {
  public string Outcome { get; set; }
  public string Stage { get; set; }
  public int Win32 { get; set; }
  public string Message { get; set; }
  public bool ProbeRemoved { get; set; }
}

public static class SusentornoShare {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("mpr.dll", EntryPoint = "WNetCancelConnection2W", CharSet = CharSet.Unicode)]
  private static extern int WNetCancelConnection2(string name, uint flags, bool force);

  public static void Write(string target, string user, string password) {
    IntPtr blob = Marshal.StringToCoTaskMemUni(password);
    try {
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = ${CRED_TYPE_DOMAIN_PASSWORD};
      credential.TargetName = target;
      credential.UserName = user;
      credential.Persist = ${CRED_PERSIST_LOCAL_MACHINE};
      credential.CredentialBlobSize = (uint)(password.Length * 2);
      credential.CredentialBlob = blob;
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.ZeroFreeCoTaskMemUnicode(blob);
    }
  }

  public static void Delete(string target) {
    if (CredDelete(target, ${CRED_TYPE_DOMAIN_PASSWORD}, 0)) return;
    int error = Marshal.GetLastWin32Error();
    if (error != 1168) throw new Win32Exception(error); // ERROR_NOT_FOUND: nothing to delete
  }

  public static void Disconnect(string unc) {
    int error = WNetCancelConnection2(unc, 0, true);
    // 2250 ERROR_NOT_CONNECTED and 1200 ERROR_BAD_DEVICE: there was no connection to close.
    if (error != 0 && error != 2250 && error != 1200) throw new Win32Exception(error);
  }

  public static int Win32Of(Exception exception) {
    Win32Exception native = exception as Win32Exception;
    if (native != null) return native.NativeErrorCode;
    int hresult = exception.HResult;
    return (hresult & unchecked((int)0xFFFF0000)) == unchecked((int)0x80070000) ? (hresult & 0xFFFF) : 0;
  }

  private static SusentornoShareResult Fail(string stage, Exception exception) {
    SusentornoShareResult result = new SusentornoShareResult();
    result.Outcome = "error";
    result.Stage = stage;
    result.Win32 = Win32Of(exception);
    result.Message = exception.Message;
    return result;
  }

  public static SusentornoShareResult Verify(string root, string probeName) {
    string stage = "read";
    SusentornoShareResult result = new SusentornoShareResult();
    try {
      byte[] content = File.ReadAllBytes(root + "\\\\${KNOWN_SHARE_FILE}");
      if (content.Length == 0) throw new IOException("${KNOWN_SHARE_FILE} is empty");
      stage = "list-pre-scripts";
      Directory.GetFileSystemEntries(root + "\\\\pre-scripts");
      stage = "list-post-scripts";
      Directory.GetFileSystemEntries(root + "\\\\post-scripts");
      stage = "probe";
      string probe = root + "\\\\" + probeName;
      FileStream stream = null;
      try {
        stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None);
      } catch (UnauthorizedAccessException) {
        result.Outcome = "ok";
        return result;
      } catch (Exception denied) {
        if (Win32Of(denied) == 5) {
          result.Outcome = "ok";
          return result;
        }
        throw;
      }
      stream.Dispose();
      result.Outcome = "writable";
      result.Stage = stage;
      try {
        File.Delete(probe);
        result.ProbeRemoved = !File.Exists(probe);
      } catch (Exception) {
        result.ProbeRemoved = false;
      }
      return result;
    } catch (Exception exception) {
      return Fail(stage, exception);
    }
  }
}`;

function scriptHeader(operation: string): string[] {
  return [
    `# susentorno share credential: ${operation}`,
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    NATIVE_HELPER_SOURCE,
    "'@",
    'function Resolve-ShareFailure($Failure) {',
    '  $inner = $Failure.Exception',
    '  while ($inner.InnerException) { $inner = $inner.InnerException }',
    '  return $inner',
    '}',
  ];
}

/** Everything a script says about an outcome is one compressed JSON line on stdout. */
const EMIT_RESULT = '[Console]::Out.Write((ConvertTo-Json -Compress $result))';

const uncPath = (target: ShareCredentialTarget, shareName: string): string =>
  `'\\\\' + ${quoteForPowerShell(target.hostIp)} + '\\' + ${quoteForPowerShell(shareName)}`;

export interface ShareCredentialSecret {
  /** The VM share account, as the host knows it. */
  account: string;
  password: string;
}

/**
 * Close any connection to the selected share, delete the entry at the address,
 * and write the new one. The password travels only inside this script, which the
 * executor sends over the redacted PowerShell Direct request; it is base64 so
 * no character can break the string, and it is never a process argument.
 */
export function buildReplaceScript(
  target: ShareCredentialTarget,
  shareName: string,
  secret: ShareCredentialSecret,
): string {
  const passwordBase64 = Buffer.from(secret.password, 'utf8').toString('base64');
  return [
    ...scriptHeader('replace'),
    `$unc = ${uncPath(target, shareName)}`,
    `$target = ${quoteForPowerShell(target.hostIp)}`,
    `$account = ${quoteForPowerShell(secret.account)}`,
    `$password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${passwordBase64}'))`,
    "$step = 'close'",
    'try {',
    '  [SusentornoShare]::Disconnect($unc)',
    "  $step = 'delete'",
    '  [SusentornoShare]::Delete($target)',
    "  $step = 'write'",
    '  [SusentornoShare]::Write($target, $account, $password)',
    "  $result = @{ Outcome = 'ok' }",
    '} catch {',
    '  $failure = Resolve-ShareFailure $_',
    "  $result = @{ Outcome = 'error'; Stage = $step; Win32 = [SusentornoShare]::Win32Of($failure); Message = $failure.Message }",
    '}',
    EMIT_RESULT,
  ].join('\n');
}

/** Read the known file, list the phase directories, and require that a probe write is denied. */
export function buildVerifyScript(target: ShareCredentialTarget, shareName: string): string {
  return [
    ...scriptHeader('verify'),
    `$root = ${uncPath(target, shareName)}`,
    "$probe = '.susentorno-probe-' + [guid]::NewGuid().ToString('N')",
    '$verdict = [SusentornoShare]::Verify($root, $probe)',
    '$result = @{',
    '  Outcome = $verdict.Outcome',
    '  Stage = $verdict.Stage',
    '  Win32 = $verdict.Win32',
    '  Message = $verdict.Message',
    '  ProbeRemoved = $verdict.ProbeRemoved',
    '}',
    EMIT_RESULT,
  ].join('\n');
}

/** Close this run's connection to the selected share. The credential entry stays. */
export function buildCloseScript(target: ShareCredentialTarget, shareName: string): string {
  return [
    ...scriptHeader('close'),
    `$unc = ${uncPath(target, shareName)}`,
    "$step = 'close'",
    'try {',
    '  [SusentornoShare]::Disconnect($unc)',
    "  $result = @{ Outcome = 'ok' }",
    '} catch {',
    '  $failure = Resolve-ShareFailure $_',
    "  $result = @{ Outcome = 'error'; Stage = $step; Win32 = [SusentornoShare]::Win32Of($failure); Message = $failure.Message }",
    '}',
    EMIT_RESULT,
  ].join('\n');
}

export interface CleanupItem {
  target: ShareCredentialTarget;
  /** Also delete the credential at the address (it was written and never verified). */
  removeCredential: boolean;
}

/** One pass over every address that needs cleanup: close the connection, then delete what was never verified. */
export function buildCleanupScript(items: CleanupItem[], shareName: string): string {
  const entries = items.map(
    (item) =>
      `@{ HostIp = ${quoteForPowerShell(item.target.hostIp)}; Unc = ${uncPath(item.target, shareName)}; Delete = $${item.removeCredential ? 'true' : 'false'} }`,
  );
  return [
    ...scriptHeader('cleanup'),
    `$items = @(${entries.join(', ')})`,
    '$results = @()',
    'foreach ($item in $items) {',
    "  $step = 'close'",
    '  try {',
    '    [SusentornoShare]::Disconnect($item.Unc)',
    '    if ($item.Delete) {',
    "      $step = 'delete'",
    '      [SusentornoShare]::Delete($item.HostIp)',
    '    }',
    "    $results += @{ HostIp = $item.HostIp; Outcome = 'ok' }",
    '  } catch {',
    '    $failure = Resolve-ShareFailure $_',
    "    $results += @{ HostIp = $item.HostIp; Outcome = 'error'; Stage = $step; Win32 = [SusentornoShare]::Win32Of($failure); Message = $failure.Message }",
    '  }',
    '}',
    '$result = @{ Results = @($results) }',
    EMIT_RESULT,
  ].join('\n');
}

// --- Running and classifying --------------------------------------------------

interface ScriptVerdict {
  Outcome?: unknown;
  Stage?: unknown;
  Win32?: unknown;
  Message?: unknown;
  ProbeRemoved?: unknown;
  Results?: unknown;
}

const MAX_DETAIL_LENGTH = 400;

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}... [truncated]`
    : trimmed;
}

function redactor(secrets: string[]): (text: string) => string {
  const needles = secrets.filter((secret) => secret.length > 0);
  return (text) =>
    needles.reduce((redacted, needle) => redacted.split(needle).join('[redacted]'), text);
}

/** Windows errors meaning the account name or password is wrong. */
const BAD_CREDENTIAL_ERRORS = new Set([
  1326, // ERROR_LOGON_FAILURE
  86, // ERROR_INVALID_PASSWORD
]);
/** The credential is right but the host account cannot log on over the network. */
const ACCOUNT_RESTRICTED_ERRORS = new Set([
  1327, // ERROR_ACCOUNT_RESTRICTION
  1328, // ERROR_INVALID_LOGON_HOURS
  1329, // ERROR_INVALID_WORKSTATION
  1330, // ERROR_PASSWORD_EXPIRED
  1331, // ERROR_ACCOUNT_DISABLED
  1385, // ERROR_LOGON_TYPE_NOT_GRANTED
  1909, // ERROR_ACCOUNT_LOCKED_OUT
]);
const CONFLICT_ERROR = 1219; // ERROR_SESSION_CREDENTIAL_CONFLICT
const UNREACHABLE_ERRORS = new Set([53, 64, 67, 121, 1231]);
const NOT_FOUND_ERRORS = new Set([0, 2, 3]);
const ACCESS_DENIED = 5;

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface VmShareCredentialsOptions {
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'> &
    Partial<Pick<WindowsGuestExecutor, 'drainCancelled'>>;
  shareName: string;
  signal?: AbortSignal;
}

export interface VmShareCredentials {
  readonly ledger: ShareCredentialLedger;
  /**
   * Close any existing connection to the selected share, delete the entry at
   * the address, write the new one. The entry is recorded as written and
   * unverified until `verify` passes.
   */
  replace(target: ShareCredentialTarget, secret: ShareCredentialSecret): Promise<void>;
  /**
   * Prove the entry works: read the known file, list `pre-scripts` and
   * `post-scripts`, and require that a probe write in the share root is denied.
   * `account` is only used to name the account in a failure.
   */
  verify(target: ShareCredentialTarget, account: string): Promise<void>;
  /** `replace`, then `verify`. */
  replaceAndVerify(target: ShareCredentialTarget, secret: ShareCredentialSecret): Promise<void>;
  /** Close this run's connection to the selected share and keep the entry. */
  close(target: ShareCredentialTarget): Promise<void>;
  /**
   * Handled failure or cancellation: close every selected-share connection this
   * run may have left open and remove only the entries it wrote but never
   * verified. It first waits for any cancelled in-flight bridge, so a replace
   * aborted by Ctrl+C cannot write its credential after the delete. Best-effort,
   * bounded at SHARE_CLEANUP_BUDGET_MS, and never throws.
   */
  cleanup(): Promise<void>;
}

export function createVmShareCredentials(options: VmShareCredentialsOptions): VmShareCredentials {
  const { executor, shareName } = options;
  const ledger = new ShareCredentialLedger();
  const vm = executor.vmName;

  async function runScript(
    script: string,
    target: ShareCredentialTarget,
    description: string,
    secrets: string[],
    limits: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ScriptVerdict> {
    const redact = redactor(secrets);
    const result = await executor.invoke(script, limits);
    if (result.timedOut) {
      throw new ShareCredentialError(
        'operation',
        target,
        `The ${description} on VM '${vm}' did not finish within ${limits.timeoutMs / 1000} seconds. ` +
          `Check that the guest is responsive, then rerun.`,
      );
    }
    if (result.exitCode !== 0) {
      const detail = bounded(redact(result.stderr || result.stdout));
      throw new ShareCredentialError(
        'operation',
        target,
        `The ${description} on VM '${vm}' failed (exit ${result.exitCode})${detail ? `: ${detail}` : '.'} ` +
          `Check that the guest is healthy, then rerun.`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as ScriptVerdict;
      }
    } catch {
      // fall through to the typed error below
    }
    throw new ShareCredentialError(
      'operation',
      target,
      `The ${description} on VM '${vm}' returned output setup could not read: ${bounded(redact(result.stdout))}`,
    );
  }

  const where = (target: ShareCredentialTarget): string =>
    `\\\\${target.hostIp}\\${shareName} (${describeTarget(target)})`;

  function classifyVerification(
    verdict: ScriptVerdict,
    target: ShareCredentialTarget,
    account: string,
  ): ShareCredentialError {
    const share = where(target);
    if (verdict.Outcome === 'writable') {
      const removal =
        verdict.ProbeRemoved === true
          ? 'The probe file it created was removed.'
          : 'The probe file it created could not be removed; delete the file named ".susentorno-probe-*" from the share directory on the host.';
      return new ShareCredentialError(
        'writable-share',
        target,
        `Account '${account}' can write to ${share} on VM '${vm}': setup created a probe file in the share root. ${removal} ` +
          `The VM share must be read-only for the guest. Grant '${account}' only Read on the SMB share and the folder ` +
          `(Revoke-SmbShareAccess / Grant-SmbShareAccess -AccessRight Read, and remove any NTFS write permission), then rerun.`,
      );
    }

    const stage = asText(verdict.Stage);
    const win32 = asNumber(verdict.Win32);
    const detail = bounded(asText(verdict.Message));
    const code = win32
      ? ` (Windows error ${win32}${detail ? `: ${detail}` : ''})`
      : detail
        ? ` (${detail})`
        : '';

    if (BAD_CREDENTIAL_ERRORS.has(win32)) {
      if (target.role === 'internal') {
        return new ShareCredentialError(
          'internal-authentication',
          target,
          `Authentication failed at ${share} on VM '${vm}' for account '${account}'${code}, although the same account ` +
            `authenticated at the Default Switch address. The unverified entry is removed. Check that nothing changed the ` +
            `host account or its password in between, then rerun the whole command.`,
        );
      }
      return new ShareCredentialError(
        'authentication',
        target,
        `The guest could not authenticate to ${share} on VM '${vm}' as account '${account}'${code}.`,
      );
    }
    if (win32 === CONFLICT_ERROR) {
      return new ShareCredentialError(
        'identity-conflict',
        target,
        `VM '${vm}' already holds an SMB connection to host address ${target.hostIp} under a different identity, ` +
          `and Windows allows only one identity per server address${code}. Close the other connections to ` +
          `${target.hostIp} in the guest ('net use \\\\${target.hostIp}\\<share> /delete' for each, or 'net use * /delete'), then rerun.`,
      );
    }
    if (ACCOUNT_RESTRICTED_ERRORS.has(win32)) {
      return new ShareCredentialError(
        'account-rejected',
        target,
        `The host refused a network logon for VM share account '${account}' at ${share}${code}. ` +
          `Check on the host that the account is enabled, unexpired, unlocked, and allowed to log on over the network ` +
          `(it must not be denied 'Access this computer from the network'), then rerun.`,
      );
    }
    if (UNREACHABLE_ERRORS.has(win32)) {
      return new ShareCredentialError(
        'share-unreachable',
        target,
        `VM '${vm}' could not reach ${share}${code}. Check that the host firewall allows SMB on that address ` +
          `and that share '${shareName}' exists on the host, then rerun.`,
      );
    }
    if (win32 === ACCESS_DENIED) {
      return new ShareCredentialError(
        'permission',
        target,
        `Account '${account}' authenticated but was denied read access at ${share} on VM '${vm}' (during ${stage || 'access'})${code}. ` +
          `Grant '${account}' Read on the SMB share and on the folder it shares, then rerun.`,
      );
    }
    if (NOT_FOUND_ERRORS.has(win32) && stage !== 'probe') {
      const missing =
        stage === 'read'
          ? `the generated file '${KNOWN_SHARE_FILE}'`
          : `the '${stage.replace('list-', '')}' directory`;
      return new ShareCredentialError(
        'missing-content',
        target,
        `${where(target)} is reachable but ${missing} is missing or empty${code}. ` +
          `The share should point at this environment's Windows VM share; run 'susentorno update-shares' to regenerate it ` +
          `and check that share '${shareName}' shares the 'vm-shared-windows' folder, then rerun.`,
      );
    }
    return new ShareCredentialError(
      'operation',
      target,
      `Verifying ${share} on VM '${vm}' failed during ${stage || 'access'}${code || ' with no detail'}. ` +
        `Check the share and its permissions on the host, then rerun.`,
    );
  }

  const credentials: VmShareCredentials = {
    ledger,

    async replace(target, secret) {
      const script = buildReplaceScript(target, shareName, secret);
      const secrets = [secret.password, Buffer.from(secret.password, 'utf8').toString('base64')];
      // Recorded before the script runs: if it fails halfway the entry may exist,
      // and cleanup must treat it as written and unverified.
      ledger.markWritten(target);
      const verdict = await runScript(
        script,
        target,
        `VM share credential replacement for ${where(target)}`,
        secrets,
        { timeoutMs: SHARE_OPERATION_TIMEOUT_MS, signal: options.signal },
      );
      if (verdict.Outcome !== 'ok') {
        const detail = bounded(redactor(secrets)(asText(verdict.Message)));
        throw new ShareCredentialError(
          'operation',
          target,
          `Could not ${asText(verdict.Stage) || 'replace'} the VM share credential for ${where(target)} on VM '${vm}'` +
            `${detail ? `: ${detail}` : '.'} Check the guest, then rerun.`,
        );
      }
    },

    async verify(target, account) {
      // The script opens the selected-share connection; it counts as open until closed.
      ledger.markConnectionOpen(target.hostIp);
      const verdict = await runScript(
        buildVerifyScript(target, shareName),
        target,
        `VM share verification for ${where(target)}`,
        [],
        { timeoutMs: SHARE_OPERATION_TIMEOUT_MS, signal: options.signal },
      );
      if (verdict.Outcome !== 'ok') throw classifyVerification(verdict, target, account);
      ledger.markVerified(target);
    },

    async replaceAndVerify(target, secret) {
      await credentials.replace(target, secret);
      await credentials.verify(target, secret.account);
    },

    async close(target) {
      const verdict = await runScript(
        buildCloseScript(target, shareName),
        target,
        `closing the connection to ${where(target)}`,
        [],
        { timeoutMs: SHARE_OPERATION_TIMEOUT_MS, signal: options.signal },
      );
      if (verdict.Outcome !== 'ok') {
        throw new ShareCredentialError(
          'operation',
          target,
          `Could not close the connection to ${where(target)} on VM '${vm}': ${bounded(asText(verdict.Message))}`,
        );
      }
      ledger.markConnectionClosed(target.hostIp);
    },

    async cleanup() {
      const unverified = ledger.unverified();
      const items = new Map<string, CleanupItem>();
      for (const hostIp of ledger.openConnections()) {
        const known = ledger.entries().find((entry) => entry.hostIp === hostIp);
        items.set(hostIp, {
          target: { role: known?.role ?? 'default', hostIp },
          removeCredential: false,
        });
      }
      for (const entry of unverified) {
        items.set(entry.hostIp, {
          target: { role: entry.role, hostIp: entry.hostIp },
          removeCredential: true,
        });
      }
      if (items.size === 0) return;

      const list = [...items.values()];
      let expired = false;
      const failAll = (): void => {
        for (const item of list)
          if (item.removeCredential) ledger.markRemovalFailed(item.target.hostIp);
      };
      const work = (async (): Promise<void> => {
        try {
          // The abandoned guest script may still be running; let it finish first.
          await executor.drainCancelled?.(SHARE_DRAIN_TIMEOUT_MS);
          // Deliberately no signal: cleanup runs after Ctrl+C aborted the flow's own.
          const verdict = await runScript(
            buildCleanupScript(list, shareName),
            list[0].target,
            'VM share cleanup',
            [],
            { timeoutMs: SHARE_CLEANUP_TIMEOUT_MS },
          );
          if (expired) return;
          const results = Array.isArray(verdict.Results)
            ? (verdict.Results as ScriptVerdict[])
            : [];
          for (const item of list) {
            const result = results.find(
              (candidate) => (candidate as { HostIp?: unknown }).HostIp === item.target.hostIp,
            );
            if (result?.Outcome === 'ok') {
              ledger.markConnectionClosed(item.target.hostIp);
              if (item.removeCredential) ledger.markRemoved(item.target.hostIp);
            } else if (item.removeCredential) {
              ledger.markRemovalFailed(item.target.hostIp);
            }
          }
        } catch {
          if (!expired) failAll();
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), SHARE_CLEANUP_BUDGET_MS);
      });
      const winner = await Promise.race([work.then(() => 'done' as const), budget]);
      clearTimeout(timer);
      if (winner === 'expired') {
        expired = true;
        failAll();
      }
    },
  };
  return credentials;
}

// --- Host checks --------------------------------------------------------------

export function buildGetLocalUserCommand(account: string): string {
  return (
    `Get-LocalUser -Name ${quoteForPowerShell(account)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Enabled = [bool]$_.Enabled } } | ConvertTo-Json -Compress`
  );
}

export function buildGetSmbShareAccessCommand(shareName: string): string {
  return (
    `Get-SmbShareAccess -Name ${quoteForPowerShell(shareName)} -ErrorAction SilentlyContinue | ` +
    // Each entry is resolved to a SID so a localized group name still matches.
    `ForEach-Object { $sid = $null; ` +
    `try { $sid = (New-Object System.Security.Principal.NTAccount([string]$_.AccountName)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }; ` +
    `[PSCustomObject]@{ AccountName = [string]$_.AccountName; Sid = $sid; AccessControlType = [string]$_.AccessControlType; AccessRight = [string]$_.AccessRight } } | ConvertTo-Json -Compress`
  );
}

/**
 * The well-known groups every network logon token holds: Everyone, NETWORK,
 * Authenticated Users, and BUILTIN\Users (which nests Authenticated Users).
 */
const IMPLICIT_TOKEN_SIDS = ['S-1-1-0', 'S-1-5-2', 'S-1-5-11', 'S-1-5-32-545'];

/**
 * The SIDs the account presents when the guest authenticates to the share: the
 * account itself, the implicit groups above, and every local group it belongs
 * to, directly or through another local group (followed to a fixed point).
 */
export function buildGetAccountTokenSidsCommand(account: string): string {
  return [
    `$sids = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)`,
    `foreach ($known in ${IMPLICIT_TOKEN_SIDS.map(quoteForPowerShell).join(', ')}) { [void]$sids.Add($known) }`,
    `[void]$sids.Add((Get-LocalUser -Name ${quoteForPowerShell(account)} -ErrorAction Stop).SID.Value)`,
    '$groups = @(Get-LocalGroup)',
    'do {',
    '  $before = $sids.Count',
    '  foreach ($group in $groups) {',
    '    if ($sids.Contains($group.SID.Value)) { continue }',
    '    $members = @(Get-LocalGroupMember -SID $group.SID -ErrorAction SilentlyContinue)',
    '    if (@($members | Where-Object { $sids.Contains($_.SID.Value) }).Count -gt 0) { [void]$sids.Add($group.SID.Value) }',
    '  }',
    '} while ($sids.Count -ne $before)',
    'ConvertTo-Json -Compress -InputObject @($sids)',
  ].join('\n');
}

function jsonList(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    );
  } catch {
    return [];
  }
}

function parseStringList(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (value): value is string => typeof value === 'string',
    );
  } catch {
    return [];
  }
}

/** Principals (by name) whose share grant reaches every authenticated local account; the fallback when an entry has no SID. */
const BROAD_PRINCIPALS = new Set(['everyone', 'nt authority\\authenticated users']);
const READABLE_RIGHTS = new Set(['read', 'change', 'full']);

export type HostShareAccountResult = { ok: true } | { ok: false; message: string };

interface ShareAccessEntry {
  principal: string;
  sid: string | undefined;
  allow: boolean;
  right: string;
}

function parseShareAccess(stdout: string): ShareAccessEntry[] {
  return jsonList(stdout).map((raw) => ({
    principal: typeof raw.AccountName === 'string' ? raw.AccountName : '',
    sid: typeof raw.Sid === 'string' && raw.Sid !== '' ? raw.Sid.toLowerCase() : undefined,
    allow:
      typeof raw.AccessControlType === 'string' && raw.AccessControlType.toLowerCase() === 'allow',
    right: typeof raw.AccessRight === 'string' ? raw.AccessRight.toLowerCase() : '',
  }));
}

/**
 * The host half of G4, before anything is written to the guest: the VM share
 * account is a host-local account, it is enabled, and the share's effective
 * access for it is at least read. Effective means what the account's network
 * logon token would get: a grant counts when it names the account or any group
 * it belongs to, and a Deny for any of those blocks it (every share right
 * includes read, so a Deny of any right does). A password is never involved.
 */
export async function checkHostShareAccount(
  exec: PowerShellExec,
  options: { account: string; shareName: string },
): Promise<HostShareAccountResult> {
  const { account, shareName } = options;

  const userResult = await exec.run(buildGetLocalUserCommand(account));
  const user = jsonList(userResult.stdout).find(
    (entry) => typeof entry.Name === 'string' && entry.Name.toLowerCase() === account.toLowerCase(),
  );
  if (!user) {
    return {
      ok: false,
      message:
        `VM share account '${account}' is not a local account on this host. Create it ` +
        `(New-LocalUser -Name '${account}' ...; see setup-environment.md) or pass the right --share-account, then rerun.`,
    };
  }
  if (user.Enabled !== true) {
    return {
      ok: false,
      message: `VM share account '${account}' is disabled on this host. Enable it (Enable-LocalUser -Name '${account}'), then rerun.`,
    };
  }

  const accessResult = await exec.run(buildGetSmbShareAccessCommand(shareName));
  const tokenResult = await exec.run(buildGetAccountTokenSidsCommand(account));
  const entries = parseShareAccess(accessResult.stdout);
  const tokenSids = new Set(parseStringList(tokenResult.stdout).map((sid) => sid.toLowerCase()));
  const accountName = account.toLowerCase();

  /** Whether an entry names the account or a group it belongs to. */
  const applies = (entry: ShareAccessEntry): boolean => {
    if (entry.sid !== undefined) return tokenSids.has(entry.sid);
    // The host could not resolve this principal to a SID: fall back to its name.
    const name = entry.principal.toLowerCase();
    return (
      name === accountName || name.endsWith(`\\${accountName}`) || BROAD_PRINCIPALS.has(name)
    );
  };

  const denial = entries.find((entry) => !entry.allow && entry.right !== '' && applies(entry));
  if (denial) {
    return {
      ok: false,
      message:
        `SMB share '${shareName}' denies VM share account '${account}' access: it has a Deny entry for ` +
        `'${denial.principal}', which the account holds (directly or through a group). ` +
        `Remove it (Unblock-SmbShareAccess -Name '${shareName}' -AccountName '${denial.principal}' -Force), ` +
        `or pass a different --share-account, then rerun.`,
    };
  }
  const readable = entries.some(
    (entry) => entry.allow && READABLE_RIGHTS.has(entry.right) && applies(entry),
  );
  if (!readable) {
    return {
      ok: false,
      message:
        `SMB share '${shareName}' does not grant VM share account '${account}' read access, directly or through a group it belongs to. ` +
        `Grant it (Grant-SmbShareAccess -Name '${shareName}' -AccountName '${account}' -AccessRight Read -Force), ` +
        `or pass the right --share-account, then rerun.`,
    };
  }
  return { ok: true };
}
