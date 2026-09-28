import { buildElevationCheckCommand } from '../elevationCheck';
import type { WindowsGuestExecutor } from './guestExecutor';

/** Each structural-check invocation is bounded at 2 minutes. */
export const STRUCTURAL_CHECK_TIMEOUT_MS = 120_000;

/**
 * A repository-approved (product, edition, architecture, release) tuple against
 * which Windows guest setup is supported. Enterprise Evaluation counts as
 * Enterprise, and neither the build number nor the language or licensing
 * channel is part of the tuple. Adding an entry is a deliberate change made
 * after the guest tier passes on that release.
 */
export interface SupportedGuestPlatform {
  product: string;
  edition: string;
  architecture: string;
  release: string;
}

export const SUPPORTED_GUEST_PLATFORMS: readonly SupportedGuestPlatform[] = [
  { product: 'Windows 11', edition: 'Enterprise', architecture: 'x64', release: '25H2' },
];

/**
 * The WinGet (App Installer) version of the current golden image. Setup relies
 * on WinGet behavior (exit codes, `source list`) that this version is known to
 * have; a guest with an older client is rejected, a newer one is accepted.
 */
export const MINIMUM_SUPPORTED_WINGET_VERSION = '1.6.10121';

export type GuestCheckName =
  'platform' | 'administrator' | 'elevation' | 'pending-reboot' | 'winget';

/**
 * A structural guest problem: the guest is reachable and the credential works,
 * but something the setup depends on is wrong. Never a reason to ask for the
 * password again. The message names the prerequisite, the VM, and the account,
 * and ends with a remediation.
 */
export class GuestCheckError extends Error {
  readonly check: GuestCheckName;

  constructor(check: GuestCheckName, message: string) {
    super(message);
    this.name = 'GuestCheckError';
    this.check = check;
  }
}

export interface GuestCheckContext {
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'>;
  /** The guest user account, for messages. */
  guestUsername: string;
  signal?: AbortSignal;
}

const MAX_DETAIL_LENGTH = 500;

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}... [truncated]`
    : trimmed;
}

async function runCheckScript(
  ctx: GuestCheckContext,
  check: GuestCheckName,
  description: string,
  script: string,
): Promise<string> {
  const result = await ctx.executor.invoke(script, {
    timeoutMs: STRUCTURAL_CHECK_TIMEOUT_MS,
    signal: ctx.signal,
  });
  if (result.timedOut) {
    throw new GuestCheckError(
      check,
      `The ${description} check on VM '${ctx.executor.vmName}' did not finish within ${STRUCTURAL_CHECK_TIMEOUT_MS / 60_000} minutes. ` +
        `Check that the guest is responsive, then rerun.`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = bounded(result.stderr || result.stdout);
    throw new GuestCheckError(
      check,
      `The ${description} check on VM '${ctx.executor.vmName}' failed (exit ${result.exitCode})${detail ? `: ${detail}` : '.'} ` +
        `Check that the guest is healthy, then rerun.`,
    );
  }
  return result.stdout;
}

function parseJsonObject(
  ctx: GuestCheckContext,
  check: GuestCheckName,
  description: string,
  stdout: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the typed error below
  }
  throw new GuestCheckError(
    check,
    `The ${description} check on VM '${ctx.executor.vmName}' returned output setup could not read: ${bounded(stdout)}`,
  );
}

function asString(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

// --- Supported guest platform -------------------------------------------------

export const PLATFORM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
  "$cv = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
  '$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1',
  '[Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{',
  '  Caption = $os.Caption',
  '  Build = $os.BuildNumber',
  '  EditionId = $cv.EditionID',
  '  DisplayVersion = $cv.DisplayVersion',
  '  ProcessorArchitecture = [int]$cpu.Architecture',
  '})))',
].join('\n');

export interface GuestPlatformReport extends SupportedGuestPlatform {
  /** Reported for diagnosis only; never checked. */
  build: string;
}

const PROCESSOR_ARCHITECTURES: Record<number, string> = {
  0: 'x86',
  5: 'arm',
  9: 'x64',
  12: 'arm64',
};

/** Turns the platform script's JSON into the tuple the allowlist is checked against. */
export function parseGuestPlatform(stdout: string): GuestPlatformReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const caption = asString(fields.Caption);
  const windowsVersion = /\bWindows (\d+)\b/.exec(caption);
  const architecture = PROCESSOR_ARCHITECTURES[Number(fields.ProcessorArchitecture)];
  return {
    product: windowsVersion ? `Windows ${windowsVersion[1]}` : caption.replace(/^Microsoft /, ''),
    // Enterprise Evaluation is the Enterprise edition under a licensing channel.
    edition: asString(fields.EditionId).replace(/Eval$/, ''),
    architecture: architecture ?? `unknown (${asString(fields.ProcessorArchitecture)})`,
    release: asString(fields.DisplayVersion),
    build: asString(fields.Build),
  };
}

export function isSupportedGuestPlatform(
  platform: SupportedGuestPlatform,
  allowlist: readonly SupportedGuestPlatform[] = SUPPORTED_GUEST_PLATFORMS,
): boolean {
  return allowlist.some(
    (entry) =>
      entry.product === platform.product &&
      entry.edition === platform.edition &&
      entry.architecture === platform.architecture &&
      entry.release === platform.release,
  );
}

function formatPlatform(platform: SupportedGuestPlatform): string {
  return `${platform.product} | ${platform.edition} | ${platform.architecture} | ${platform.release}`;
}

export async function checkSupportedPlatform(
  ctx: GuestCheckContext,
  allowlist: readonly SupportedGuestPlatform[] = SUPPORTED_GUEST_PLATFORMS,
): Promise<GuestPlatformReport> {
  const stdout = await runCheckScript(ctx, 'platform', 'guest platform', PLATFORM_SCRIPT);
  const platform = parseGuestPlatform(stdout);
  if (!platform) {
    throw new GuestCheckError(
      'platform',
      `The guest platform check on VM '${ctx.executor.vmName}' returned output setup could not read: ${bounded(stdout)}`,
    );
  }
  if (!isSupportedGuestPlatform(platform, allowlist)) {
    throw new GuestCheckError(
      'platform',
      `VM '${ctx.executor.vmName}' runs ${formatPlatform(platform)} (build ${platform.build}), which is not a supported guest platform. ` +
        `Supported: ${allowlist.map(formatPlatform).join('; ')}. ` +
        `Install a supported Windows release and complete Windows Update, then rerun.`,
    );
  }
  return platform;
}

// --- Local administrator ------------------------------------------------------

const ADMINISTRATORS_SID = 'S-1-5-32-544';

export const ADMINISTRATOR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$local = Get-LocalUser -SID $sid -ErrorAction SilentlyContinue',
  '$member = $false',
  'if ($local) {',
  `  $member = [bool](Get-LocalGroupMember -SID '${ADMINISTRATORS_SID}' -ErrorAction Stop | Where-Object { $_.SID.Value -eq $sid.Value })`,
  '}',
  '[Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{',
  '  IsLocal = [bool]$local',
  '  Enabled = [bool]($local -and $local.Enabled)',
  '  IsAdministratorsMember = $member',
  '})))',
].join('\n');

export async function checkLocalAdministrator(ctx: GuestCheckContext): Promise<void> {
  const stdout = await runCheckScript(
    ctx,
    'administrator',
    'local administrator',
    ADMINISTRATOR_SCRIPT,
  );
  const fields = parseJsonObject(ctx, 'administrator', 'local administrator', stdout);
  const where = `guest user account '${ctx.guestUsername}' on VM '${ctx.executor.vmName}'`;
  if (fields.IsLocal !== true) {
    throw new GuestCheckError(
      'administrator',
      `The ${where} is not a local account. Setup needs an existing local administrator; ` +
        `rerun with a local account (Microsoft and domain accounts are not supported).`,
    );
  }
  if (fields.Enabled !== true) {
    throw new GuestCheckError(
      'administrator',
      `The ${where} is disabled. Enable it in the guest (Enable-LocalUser -Name '${ctx.guestUsername}'), then rerun.`,
    );
  }
  if (fields.IsAdministratorsMember !== true) {
    throw new GuestCheckError(
      'administrator',
      `The ${where} is not a member of the local Administrators group. ` +
        `Add it in the guest (Add-LocalGroupMember -Group Administrators -Member '${ctx.guestUsername}'), then rerun.`,
    );
  }
}

// --- Elevated token -----------------------------------------------------------

export async function checkElevatedToken(ctx: GuestCheckContext): Promise<void> {
  const stdout = await runCheckScript(
    ctx,
    'elevation',
    'elevated token',
    buildElevationCheckCommand(),
  );
  if (stdout.trim() !== 'True') {
    throw new GuestCheckError(
      'elevation',
      `The PowerShell Direct session for guest user account '${ctx.guestUsername}' on VM '${ctx.executor.vmName}' is not elevated. ` +
        `Use the built-in Administrator account, or disable UAC remote token filtering for the account, then rerun.`,
    );
  }
}

// --- Pending reboot -----------------------------------------------------------

export const PENDING_REBOOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$markers = New-Object System.Collections.Generic.List[string]',
  "if (Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $markers.Add('Component Based Servicing\\RebootPending') }",
  "if (Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $markers.Add('Windows Update\\RebootRequired') }",
  "$rename = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue",
  "if ($rename -and @($rename.PendingFileRenameOperations | Where-Object { $_ }).Count -gt 0) { $markers.Add('Session Manager\\PendingFileRenameOperations') }",
  '[Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{ Markers = @($markers) })))',
].join('\n');

export interface PendingRebootProbe {
  pending: boolean;
  /** The standard markers found, by short name. */
  markers: string[];
}

/**
 * Whether the guest has a standard pending-reboot marker. Reusable on its own:
 * G3 runs it before provisioning, and the isolation gate runs it again after.
 * It reports a probe failure as a GuestCheckError rather than as "no reboot".
 */
export async function probePendingReboot(
  ctx: Pick<GuestCheckContext, 'executor' | 'signal'> & { guestUsername?: string },
): Promise<PendingRebootProbe> {
  const fullCtx: GuestCheckContext = { guestUsername: '', ...ctx };
  const stdout = await runCheckScript(
    fullCtx,
    'pending-reboot',
    'pending-reboot',
    PENDING_REBOOT_SCRIPT,
  );
  const fields = parseJsonObject(fullCtx, 'pending-reboot', 'pending-reboot', stdout);
  const raw = fields.Markers;
  const markers = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(asString);
  return { pending: markers.length > 0, markers };
}

export const PENDING_REBOOT_REMEDIATION = 'Restart the guest, then rerun.';

export async function checkNoPendingReboot(ctx: GuestCheckContext): Promise<void> {
  const probe = await probePendingReboot(ctx);
  if (probe.pending) {
    throw new GuestCheckError(
      'pending-reboot',
      `VM '${ctx.executor.vmName}' has a pending reboot (${probe.markers.join(', ')}). ` +
        PENDING_REBOOT_REMEDIATION,
    );
  }
}

// --- WinGet -------------------------------------------------------------------

export const WINGET_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$winget = Get-Command -Name winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source',
  'if (-not $winget) {',
  "  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\winget.exe'",
  '  if (Test-Path -LiteralPath $alias) { $winget = $alias }',
  '}',
  'if (-not $winget) {',
  '  [Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{ Found = $false })))',
  '  exit 0',
  '}',
  '$versionOutput = (& $winget --version 2>&1 | Out-String).Trim()',
  '$versionExit = $LASTEXITCODE',
  '$sourceOutput = (& $winget source list 2>&1 | Out-String)',
  '$sourceExit = $LASTEXITCODE',
  '[Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{',
  '  Found = $true',
  '  Path = $winget',
  '  Version = $versionOutput',
  '  VersionExit = $versionExit',
  '  Sources = $sourceOutput',
  '  SourcesExit = $sourceExit',
  '})))',
].join('\n');

/** `v1.12.470` and `1.12.470` both become `[1, 12, 470]`; anything else is null. */
export function parseWingetVersion(text: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(text.trim());
  return match ? match[1].split('.').map(Number) : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** A source is usable when `winget source list` lists the `winget` source with an endpoint. */
export function listsWingetSource(sourceListOutput: string): boolean {
  return /^\s*winget\s+\S+/im.test(sourceListOutput);
}

export interface WingetReport {
  path: string;
  version: string;
}

export async function checkWinget(
  ctx: GuestCheckContext,
  minimumVersion: string = MINIMUM_SUPPORTED_WINGET_VERSION,
): Promise<WingetReport> {
  const stdout = await runCheckScript(ctx, 'winget', 'WinGet', WINGET_SCRIPT);
  const fields = parseJsonObject(ctx, 'winget', 'WinGet', stdout);
  const vm = ctx.executor.vmName;
  const fix =
    'Install or repair App Installer in the guest (Microsoft Store, or Add-AppxPackage with the current ' +
    `App Installer package), confirm 'winget --version' works in the guest, then rerun.`;

  if (fields.Found !== true) {
    throw new GuestCheckError(
      'winget',
      `WinGet was not found in the guest (VM '${vm}', account '${ctx.guestUsername}'). ${fix}`,
    );
  }
  const versionText = asString(fields.Version);
  if (fields.VersionExit !== 0) {
    throw new GuestCheckError(
      'winget',
      `'winget --version' failed in the guest (VM '${vm}', exit ${asString(fields.VersionExit)}): ${bounded(versionText)}. ${fix}`,
    );
  }
  const version = parseWingetVersion(versionText);
  const minimum = parseWingetVersion(minimumVersion)!;
  if (!version) {
    throw new GuestCheckError(
      'winget',
      `WinGet in the guest (VM '${vm}') reported a version setup could not read: ${bounded(versionText)}. ${fix}`,
    );
  }
  if (compareVersions(version, minimum) < 0) {
    throw new GuestCheckError(
      'winget',
      `WinGet ${versionText.trim()} in the guest (VM '${vm}') is older than the supported ${minimumVersion}. ` +
        `Update App Installer in the guest, then rerun.`,
    );
  }
  if (fields.SourcesExit !== 0 || !listsWingetSource(asString(fields.Sources))) {
    throw new GuestCheckError(
      'winget',
      `WinGet in the guest (VM '${vm}') has no usable 'winget' source ('winget source list' exit ${asString(fields.SourcesExit)}). ` +
        `Run 'winget source reset --force' in the guest, then rerun.`,
    );
  }
  return { path: asString(fields.Path), version: versionText.trim() };
}

// --- G3 -----------------------------------------------------------------------

export interface GuestStructuralReport {
  platform: GuestPlatformReport;
  winget: WingetReport;
}

/**
 * G3: every structural check, in order, stopping at the first failure. A
 * failure throws GuestCheckError and never means "ask for the password again".
 */
export async function runGuestStructuralChecks(
  ctx: GuestCheckContext,
): Promise<GuestStructuralReport> {
  const platform = await checkSupportedPlatform(ctx);
  await checkLocalAdministrator(ctx);
  await checkElevatedToken(ctx);
  await checkNoPendingReboot(ctx);
  const winget = await checkWinget(ctx);
  return { platform, winget };
}
