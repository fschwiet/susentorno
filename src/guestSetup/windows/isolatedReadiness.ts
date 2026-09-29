import { sleep as abortableSleep } from '../../runHosting/abortableSleep';
import { quoteForPowerShell } from '../quoteForPowerShell';
import { WindowsGuestError, type WindowsGuestExecutor } from './guestExecutor';

/** Phase G11 polls for 3 minutes. */
export const ISOLATED_READINESS_DEADLINE_MS = 3 * 60_000;
export const ISOLATED_READINESS_POLL_INTERVAL_MS = 5_000;
export const ISOLATED_READINESS_HEARTBEAT_INTERVAL_MS = 15_000;
/** Each probe is one short guest invocation; the deadline covers the polling, not one hung probe. */
export const ISOLATED_PROBE_TIMEOUT_MS = 60_000;
/** A name the host's resolver answers for any guest, allow-listed or not. */
export const ISOLATED_DNS_LOOKUP_NAME = 'example.com';
/** The proxy stack's TLS port on the Internal-switch host address. */
export const PROXY_STACK_PORT = 443;
export const ISOLATED_PROBE_HEADER = '# susentorno isolated readiness';

/**
 * What the guest reports. The script only gathers facts; deciding whether they
 * amount to a working isolated network is `evaluateIsolatedFacts`, in the host.
 */
export interface IsolatedProbeFacts {
  /** Non-loopback, non-link-local IPv4 addresses. `Origin` is the prefix origin (`Dhcp`, `Manual`, ...). */
  Addresses: { InterfaceIndex: number; Address: string; PrefixLength: number; Origin: string }[];
  /** Default IPv4 routes. */
  Routes: { InterfaceIndex: number; NextHop: string }[];
  DnsServers: { InterfaceIndex: number; Servers: string[] }[];
  /** A lookup asked of the host's resolver directly. */
  Lookup: { Ok: boolean; Detail: string };
  /** A TCP connection to the proxy stack at the host address. */
  Proxy: { Ok: boolean; Detail: string };
}

export type IsolatedCondition = 'lease' | 'gateway' | 'dns' | 'proxy';

export interface UnmetCondition {
  condition: IsolatedCondition;
  detail: string;
}

const CONDITION_DESCRIPTIONS: Record<IsolatedCondition, string> = {
  lease: "a DHCP lease in run-hosting's subnet",
  gateway: 'the host as default gateway',
  dns: 'DNS through the host',
  proxy: 'a TCP connection to the proxy stack',
};

/** The guest half of G11: one JSON object of facts on stdout. */
export function buildIsolatedProbeScript(hostIp: string): string {
  return [
    ISOLATED_PROBE_HEADER,
    "$ErrorActionPreference = 'Stop'",
    `$hostIp = ${quoteForPowerShell(hostIp)}`,
    '$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |',
    "  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |",
    '  ForEach-Object { [ordered]@{ InterfaceIndex = [int]$_.InterfaceIndex; Address = [string]$_.IPAddress; PrefixLength = [int]$_.PrefixLength; Origin = [string]$_.PrefixOrigin } })',
    "$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |",
    '  ForEach-Object { [ordered]@{ InterfaceIndex = [int]$_.InterfaceIndex; NextHop = [string]$_.NextHop } })',
    '$dnsServers = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |',
    '  ForEach-Object { [ordered]@{ InterfaceIndex = [int]$_.InterfaceIndex; Servers = @($_.ServerAddresses) } })',
    'try {',
    `  $answers = @(Resolve-DnsName -Name ${quoteForPowerShell(ISOLATED_DNS_LOOKUP_NAME)} -Type A -DnsOnly -Server $hostIp -ErrorAction Stop | Where-Object { $_.Type -eq 'A' })`,
    "  $lookup = [ordered]@{ Ok = ($answers.Count -gt 0); Detail = $(if ($answers.Count -gt 0) { [string]$answers[0].IPAddress } else { 'the host answered with no address' }) }",
    '} catch {',
    '  $lookup = [ordered]@{ Ok = $false; Detail = [string]$_.Exception.Message }',
    '}',
    '$client = New-Object System.Net.Sockets.TcpClient',
    'try {',
    `  $pending = $client.BeginConnect($hostIp, ${PROXY_STACK_PORT}, $null, $null)`,
    '  if ($pending.AsyncWaitHandle.WaitOne(5000)) {',
    '    $client.EndConnect($pending)',
    "    $proxy = [ordered]@{ Ok = [bool]$client.Connected; Detail = 'connected' }",
    '  } else {',
    "    $proxy = [ordered]@{ Ok = $false; Detail = 'the connection timed out after 5 seconds' }",
    '  }',
    '} catch {',
    '  $proxy = [ordered]@{ Ok = $false; Detail = [string]$_.Exception.Message }',
    '} finally {',
    '  $client.Close()',
    '}',
    '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 5 ([ordered]@{',
    '  Addresses = $addresses',
    '  Routes = $routes',
    '  DnsServers = $dnsServers',
    '  Lookup = $lookup',
    '  Proxy = $proxy',
    '})))',
  ].join('\n');
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function inSameSubnet(address: string, other: string, prefixLength: number): boolean {
  const a = ipv4ToInt(address);
  const b = ipv4ToInt(other);
  if (a === null || b === null || prefixLength < 1 || prefixLength > 32) return false;
  const block = 2 ** (32 - prefixLength);
  return Math.floor(a / block) === Math.floor(b / block);
}

/** A boolean-ish JSON value the script might emit as a scalar instead of an array. */
function list<T>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/**
 * Which of the isolated-network conditions the facts do not yet establish:
 * a DHCP lease in the subnet of the host address, that host as the default
 * gateway of the leased adapter, that host as the adapter's resolver and
 * answering a lookup, and a TCP connection to the proxy stack. Empty means ready.
 */
export function evaluateIsolatedFacts(facts: IsolatedProbeFacts, hostIp: string): UnmetCondition[] {
  const unmet: UnmetCondition[] = [];
  const addresses = list<IsolatedProbeFacts['Addresses'][number]>(facts.Addresses);
  const routes = list<IsolatedProbeFacts['Routes'][number]>(facts.Routes);
  const dnsServers = list<IsolatedProbeFacts['DnsServers'][number]>(facts.DnsServers);

  const dhcp = addresses.filter((entry) => String(entry.Origin).toLowerCase() === 'dhcp');
  const leased = dhcp.filter((entry) => inSameSubnet(entry.Address, hostIp, entry.PrefixLength));
  if (leased.length === 0) {
    unmet.push({
      condition: 'lease',
      detail:
        dhcp.length === 0
          ? 'the guest has no DHCP-assigned IPv4 address yet'
          : `the guest holds DHCP address ${dhcp.map((e) => `${e.Address}/${e.PrefixLength}`).join(', ')}, outside the subnet of ${hostIp}`,
    });
  }
  const leasedInterfaces = new Set(leased.map((entry) => entry.InterfaceIndex));

  const gateways = routes.filter((route) => leasedInterfaces.has(route.InterfaceIndex));
  if (!gateways.some((route) => route.NextHop === hostIp)) {
    unmet.push({
      condition: 'gateway',
      detail:
        gateways.length === 0
          ? `the leased adapter has no default route (expected ${hostIp})`
          : `the default gateway is ${gateways.map((r) => r.NextHop).join(', ')}, expected ${hostIp}`,
    });
  }

  const configured = dnsServers
    .filter((entry) => leasedInterfaces.has(entry.InterfaceIndex))
    .flatMap((entry) => list<string>(entry.Servers));
  const lookup = facts.Lookup ?? { Ok: false, Detail: 'no lookup result' };
  if (!configured.includes(hostIp)) {
    unmet.push({
      condition: 'dns',
      detail:
        configured.length === 0
          ? `the leased adapter has no DNS server (expected ${hostIp})`
          : `the guest's DNS server is ${configured.join(', ')}, expected ${hostIp}`,
    });
  } else if (!lookup.Ok) {
    unmet.push({
      condition: 'dns',
      detail: `a lookup of ${ISOLATED_DNS_LOOKUP_NAME} through ${hostIp} failed: ${lookup.Detail}`,
    });
  }

  const proxy = facts.Proxy ?? { Ok: false, Detail: 'no connection result' };
  if (!proxy.Ok) {
    unmet.push({
      condition: 'proxy',
      detail: `could not connect to the proxy stack at ${hostIp}:${PROXY_STACK_PORT}: ${proxy.Detail}`,
    });
  }
  return unmet;
}

/**
 * The isolated network did not come up in time. Names every condition that was
 * still unmet at the deadline and points at `run-hosting`, the host side that
 * serves all of them. Structural: nothing the flow can retry.
 */
export class IsolatedReadinessError extends Error {
  readonly unmet: UnmetCondition[];

  constructor(vmName: string, hostIp: string, deadlineMs: number, unmet: UnmetCondition[]) {
    const minutes = deadlineMs / 60_000;
    const waited = Number.isInteger(minutes)
      ? `${minutes} minute${minutes === 1 ? '' : 's'}`
      : `${Math.round(deadlineMs / 1000)} seconds`;
    super(
      `VM '${vmName}' did not get a working isolated network within ${waited}. Still unmet:\n` +
        unmet
          .map((entry) => `  - ${CONDITION_DESCRIPTIONS[entry.condition]}: ${entry.detail}`)
          .join('\n') +
        `\nCheck that 'susentorno run-hosting' is running for this isolation name and serving ${hostIp} ` +
        `(DHCP on UDP 67, DNS on UDP 53, the proxy stack on TCP ${PROXY_STACK_PORT}), then rerun.`,
    );
    this.name = 'IsolatedReadinessError';
    this.unmet = unmet;
  }
}

export interface WaitForIsolatedNetworkOptions {
  /** The Internal-switch host IP: gateway, resolver, and proxy stack. */
  hostIp: string;
  deadlineMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Called about every heartbeat interval with what is still unmet. */
  onHeartbeat?: (elapsedMs: number, unmet: UnmetCondition[]) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function parseFacts(stdout: string): IsolatedProbeFacts | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as IsolatedProbeFacts)
      : null;
  } catch {
    return null;
  }
}

/**
 * Polls the guest until the isolated network works, for up to the deadline.
 * A probe that fails to run (the guest is still settling) counts as everything
 * unmet and is retried; an authentication rejection or a cancellation is thrown
 * at once, so a wrong credential never turns into a readiness timeout.
 */
export async function waitForIsolatedNetwork(
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'>,
  options: WaitForIsolatedNetworkOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadlineMs = options.deadlineMs ?? ISOLATED_READINESS_DEADLINE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ISOLATED_READINESS_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? ISOLATED_READINESS_HEARTBEAT_INTERVAL_MS;
  const script = buildIsolatedProbeScript(options.hostIp);
  const started = now();
  let lastHeartbeat = 0;

  for (;;) {
    if (options.signal?.aborted) {
      throw new WindowsGuestError(
        'cancelled',
        'The isolated-network readiness wait was cancelled.',
      );
    }
    let unmet: UnmetCondition[];
    try {
      const result = await executor.invoke(script, {
        timeoutMs: ISOLATED_PROBE_TIMEOUT_MS,
        signal: options.signal,
      });
      const facts = result.exitCode === 0 && !result.timedOut ? parseFacts(result.stdout) : null;
      if (facts) {
        unmet = evaluateIsolatedFacts(facts, options.hostIp);
      } else {
        const why = result.timedOut
          ? 'the probe timed out inside the guest'
          : `the probe exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`;
        unmet = probeFailed(why);
      }
    } catch (error) {
      if (!(error instanceof WindowsGuestError)) throw error;
      if (error.kind !== 'transport' && error.kind !== 'deadline') throw error;
      unmet = probeFailed(error.message);
    }

    if (unmet.length === 0) return;

    const elapsed = now() - started;
    if (elapsed >= deadlineMs) {
      throw new IsolatedReadinessError(executor.vmName, options.hostIp, deadlineMs, unmet);
    }
    if (elapsed - lastHeartbeat >= heartbeatIntervalMs) {
      lastHeartbeat = elapsed;
      options.onHeartbeat?.(elapsed, unmet);
    }
    await sleep(Math.min(pollIntervalMs, deadlineMs - elapsed), options.signal);
  }
}

/** A probe that never produced facts leaves every condition unproven. */
function probeFailed(why: string): UnmetCondition[] {
  const detail = `the guest could not be probed (${why})`;
  return (['lease', 'gateway', 'dns', 'proxy'] as const).map((condition) => ({
    condition,
    detail,
  }));
}
