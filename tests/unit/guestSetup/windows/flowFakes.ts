import { X509Certificate } from 'node:crypto';
import { PromptEndedError, type SetupAnswerPrompts } from '../../../../src/cliPrompt';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import {
  WindowsGuestError,
  type WindowsGuestCredential,
  type WindowsGuestExecutor,
  type WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import {
  ADMINISTRATOR_SCRIPT,
  MINIMUM_SUPPORTED_WINGET_VERSION,
  PENDING_REBOOT_SCRIPT,
  PLATFORM_SCRIPT,
  WINGET_SCRIPT,
} from '../../../../src/guestSetup/windows/guestChecks';
import type { WindowsHostContext } from '../../../../src/guestSetup/windows/hostPrerequisites';
import {
  ISOLATED_PROBE_HEADER,
  type IsolatedProbeFacts,
} from '../../../../src/guestSetup/windows/isolatedReadiness';
import type { WindowsSetupClock } from '../../../../src/guestSetup/windows/setupFlow';
import type { GuestScript } from '../../../../src/guestSetup/listScripts';
import type {
  WindowsStepPlanResult,
  WindowsStepPlans,
} from '../../../../src/guestSetup/windows/stepPlan';
import { makeCertificate } from './testCerts';

/** The environment proxy CA the fake share carries, and one ambient root the fake host selects. */
export const FLOW_PROXY_CA = makeCertificate('flow-proxy-ca');
export const FLOW_AMBIENT_ROOT = makeCertificate('flow-ambient-root');
export const readProxyCaPem = (): string => FLOW_PROXY_CA.pem;

export const SHARE_DIR = 'C:\\work\\project\\.susentorno\\vm-shared-windows';

export const HOST_CONTEXT: WindowsHostContext = {
  vmSharedWindowsPath: SHARE_DIR,
  natAdapterAlias: 'vEthernet (Default Switch)',
  defaultSwitchName: 'Default Switch',
  internalAdapterAlias: 'vEthernet (susentorno-internal)',
  internalSwitchName: 'susentorno-internal',
  internalSwitchHostIp: '192.168.67.1',
  defaultSwitchHostIp: '172.29.240.1',
};

/** Every prompt and every host command in one ordered log, so ordering can be asserted across both. */
export type EventLog = string[];

export interface ScriptedPrompts {
  prompts: SetupAnswerPrompts;
  asked: { kind: 'text' | 'masked'; question: string; defaultValue?: string }[];
}

/**
 * Answers come from a per-question queue; an exhausted queue behaves like EOF.
 * A question mapped to 'hang' never resolves (the user has not answered yet); 'cancel' is Ctrl+C at it.
 */
export function scriptedPrompts(
  answers: Record<string, string[] | 'hang' | 'cancel'>,
  events: EventLog = [],
): ScriptedPrompts {
  const asked: ScriptedPrompts['asked'] = [];
  const next = async (question: string): Promise<string> => {
    const queue = answers[question];
    if (queue === 'hang') return new Promise<string>(() => {});
    if (queue === 'cancel') throw new PromptEndedError('cancelled', question, 'cancelled');
    const value = queue?.shift();
    if (value === undefined) throw new PromptEndedError('eof', question);
    return value;
  };
  return {
    asked,
    prompts: {
      async text(question, defaultValue) {
        asked.push({ kind: 'text', question, defaultValue });
        events.push(`prompt:${question}`);
        const answer = await next(question);
        return answer === '' && defaultValue !== undefined ? defaultValue : answer;
      },
      async masked(question) {
        asked.push({ kind: 'masked', question });
        events.push(`prompt:${question}`);
        return next(question);
      },
    },
  };
}

export interface FakeHyperV {
  exec: PowerShellExec;
  commands: string[];
  timeouts: { command: string; timeoutMs?: number }[];
  state: {
    vmState: string;
    switchName: string | null;
    adapters: number;
    /** Whether run-hosting's DHCP and DNS listeners are bound; a test may drop them mid-run. */
    listeners: boolean;
    /** Stop-VM returns but the VM never reaches Off. */
    stopStalls: boolean;
    /** A host command matching this fails with exit 1 (for example the adapter connect). */
    failing?: RegExp;
  };
}

/** A stateful stand-in for the Hyper-V and networking cmdlets the setup flow runs on the host. */
export function fakeHyperV(
  initial: Partial<FakeHyperV['state']> = {},
  options: {
    events?: EventLog;
    stopNeverCompletes?: boolean;
    listeners?: boolean;
    sharePath?: string;
    /** Host-local accounts that exist (default: the documented `susentorno`). */
    localAccounts?: string[];
    /** Whether the SMB share grants those accounts read access (default true). */
    shareGrantsRead?: boolean;
    /** Make the host root enumeration fail (phase G5's host enumeration). */
    hostRootsFail?: boolean;
  } = {},
): FakeHyperV {
  const state: FakeHyperV['state'] = {
    vmState: 'Off',
    switchName: 'Default Switch' as string | null,
    adapters: 1,
    listeners: options.listeners !== false,
    stopStalls: options.stopNeverCompletes === true,
    ...initial,
  };
  const commands: string[] = [];
  const timeouts: FakeHyperV['timeouts'] = [];
  const exec: PowerShellExec = {
    async run(command, opts) {
      commands.push(command);
      timeouts.push({ command, timeoutMs: opts?.timeoutMs });
      options.events?.push(`host:${command.split(' ')[0]}`);
      const ok = (stdout = ''): { exitCode: number; stdout: string } => ({ exitCode: 0, stdout });
      if (command.startsWith('Get-VM -Name')) {
        return ok(JSON.stringify({ Name: 'win-dev', State: state.vmState }));
      }
      if (command.startsWith('Get-VMNetworkAdapter')) {
        const entry = { SwitchName: state.switchName, IPAddresses: [] };
        return ok(JSON.stringify(state.adapters === 1 ? entry : Array(state.adapters).fill(entry)));
      }
      if (command.startsWith('Get-VMSwitch')) return ok('{"Name":"x"}');
      if (command.includes('$disallowed')) {
        if (options.hostRootsFail) return { exitCode: 1, stdout: 'Access is denied' };
        return ok(
          JSON.stringify({
            Roots: [
              {
                Thumbprint: 'AA',
                RawDataBase64: new X509Certificate(FLOW_AMBIENT_ROOT.pem).raw.toString('base64'),
              },
            ],
            Disallowed: [],
          }),
        );
      }
      if (command.startsWith('Get-NetUDPEndpoint')) {
        return state.listeners ? ok('bound') : ok('');
      }
      if (command.startsWith('Get-SmbShare ')) {
        return ok(
          JSON.stringify({ Name: 'vm-shared-windows', Path: options.sharePath ?? SHARE_DIR }),
        );
      }
      if (command.startsWith('Get-LocalUser')) {
        const name = /-Name '((?:[^']|'')*)'/.exec(command)![1].replace(/''/g, "'");
        const found = (options.localAccounts ?? ['susentorno']).find(
          (account) => account.toLowerCase() === name.toLowerCase(),
        );
        return ok(found ? JSON.stringify({ Name: found, Enabled: true }) : '');
      }
      if (command.includes('Get-LocalGroupMember')) {
        // The account's token SIDs; the fake's share entries carry no SID, so they match by name.
        return ok('[]');
      }
      if (command.startsWith('Get-SmbShareAccess')) {
        if (options.shareGrantsRead === false) return ok('');
        return ok(
          JSON.stringify(
            (options.localAccounts ?? ['susentorno']).map((account) => ({
              AccountName: `WIN-HOST\\${account}`,
              AccessControlType: 'Allow',
              AccessRight: 'Read',
            })),
          ),
        );
      }
      if (state.failing?.test(command)) return { exitCode: 1, stdout: 'The operation failed.' };
      if (command.startsWith('Stop-VM')) {
        if (!state.stopStalls) state.vmState = 'Off';
        return ok();
      }
      if (command.startsWith('Connect-VMNetworkAdapter')) {
        state.switchName = /-SwitchName '([^']*)'/.exec(command)![1];
        return ok();
      }
      if (command.startsWith('Start-VM')) {
        state.vmState = 'Running';
        return ok();
      }
      throw new Error(`fakeHyperV: unexpected command: ${command}`);
    },
  };
  return { exec, commands, timeouts, state };
}

export const guestOk = (stdout: string): WindowsGuestResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

export const SUPPORTED_GUEST_RESPONSES: Record<string, WindowsGuestResult> = {
  platform: guestOk(
    JSON.stringify({
      Caption: 'Microsoft Windows 11 Enterprise Evaluation',
      Build: '26200',
      EditionId: 'EnterpriseEval',
      DisplayVersion: '25H2',
      ProcessorArchitecture: 9,
    }),
  ),
  admin: guestOk(JSON.stringify({ IsLocal: true, Enabled: true, IsAdministratorsMember: true })),
  elevation: guestOk('True'),
  pending: guestOk(JSON.stringify({ Markers: [] })),
  winget: guestOk(
    JSON.stringify({
      Found: true,
      Path: 'C:\\winget.exe',
      Version: `v${MINIMUM_SUPPORTED_WINGET_VERSION}`,
      VersionExit: 0,
      Sources: 'Name Argument\r\nwinget https://cdn.winget.microsoft.com/cache\r\n',
      SourcesExit: 0,
    }),
  ),
};

/** What the isolated-readiness probe reports for a guest whose isolated network works. */
export function isolatedFacts(overrides: Partial<IsolatedProbeFacts> = {}): IsolatedProbeFacts {
  return {
    Addresses: [{ InterfaceIndex: 7, Address: '192.168.67.44', PrefixLength: 24, Origin: 'Dhcp' }],
    Routes: [{ InterfaceIndex: 7, NextHop: HOST_CONTEXT.internalSwitchHostIp }],
    DnsServers: [{ InterfaceIndex: 7, Servers: [HOST_CONTEXT.internalSwitchHostIp] }],
    Lookup: { Ok: true, Detail: HOST_CONTEXT.internalSwitchHostIp },
    Proxy: { Ok: true, Detail: 'connected' },
    ...overrides,
  };
}

/** The guest's Credential Manager and SMB behavior, stateful across a run. */
export interface ShareGuest {
  /** The credential currently stored per host address (by the replace script). */
  stored: Map<string, { account: string; password: string }>;
  /** Whether the stored credential at this address authenticates (default: always). */
  accepts?: (credential: { account: string; password: string }, hostIp: string) => boolean;
  /** Replaces the answer to a verify or replace script outright. */
  override?: Partial<
    Record<'replace' | 'verify' | 'close' | 'cleanup', WindowsGuestResult | Error>
  >;
}

export const shareGuest = (options: Partial<ShareGuest> = {}): ShareGuest => ({
  stored: new Map(),
  ...options,
});

const shareOperation = (script: string): string | undefined =>
  /^# susentorno share credential: (\w+)/.exec(script)?.[1];

function shareAnswer(script: string, guest: ShareGuest): WindowsGuestResult | Error {
  const operation = shareOperation(script)! as 'replace' | 'verify' | 'close' | 'cleanup';
  const override = guest.override?.[operation];
  if (override) return override;
  if (operation === 'replace') {
    const hostIp = /\$target = '([^']+)'/.exec(script)![1];
    const account = /\$account = '((?:[^']|'')*)'/.exec(script)![1].replace(/''/g, "'");
    const base64 = /FromBase64String\('([^']+)'\)/.exec(script)![1];
    guest.stored.set(hostIp, { account, password: Buffer.from(base64, 'base64').toString('utf8') });
    return guestOk(JSON.stringify({ Outcome: 'ok' }));
  }
  if (operation === 'verify') {
    const hostIp = /\$root = '\\\\' \+ '([^']+)'/.exec(script)![1];
    const credential = guest.stored.get(hostIp);
    if (guest.accepts && (!credential || !guest.accepts(credential, hostIp))) {
      return guestOk(
        JSON.stringify({ Outcome: 'error', Stage: 'read', Win32: 1326, Message: 'logon failure' }),
      );
    }
    return guestOk(JSON.stringify({ Outcome: 'ok' }));
  }
  if (operation === 'cleanup') {
    const results = [
      ...script.matchAll(/HostIp = '([^']+)'; Unc = [^@]*?Delete = \$(true|false)/g),
    ].map((match) => {
      if (match[2] === 'true') guest.stored.delete(match[1]);
      return { HostIp: match[1], Outcome: 'ok' };
    });
    return guestOk(JSON.stringify({ Results: results }));
  }
  return guestOk(JSON.stringify({ Outcome: 'ok' }));
}

/** The guest's root store and managed trust state, stateful across a run. */
export interface TrustGuest {
  roots: string[];
  /** Replaces the answer to one trust operation (by script header) outright. */
  override?: Record<string, WindowsGuestResult | Error>;
}

export const trustGuest = (options: Partial<TrustGuest> = {}): TrustGuest => ({
  roots: [],
  ...options,
});

const trustOperation = (script: string): string | undefined =>
  /^# susentorno trust: ([\w-]+)/.exec(script)?.[1];

function trustAnswer(script: string, guest: TrustGuest): WindowsGuestResult | Error {
  const operation = trustOperation(script)!;
  const override = guest.override?.[operation];
  if (override) return override;
  const shas = [...script.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
  switch (operation) {
    case 'inspect':
      return guestOk(
        JSON.stringify({
          Outcome: 'ok',
          Roots: guest.roots,
          Manifest: null,
          ProxyFile: null,
          Files: [],
        }),
      );
    case 'roots':
      return guestOk(JSON.stringify({ Outcome: 'ok', Roots: guest.roots }));
    case 'import-ambient':
    case 'import-proxy':
      guest.roots.push(...shas);
      return guestOk(JSON.stringify({ Outcome: 'ok' }));
    case 'remove-proxy':
      guest.roots = guest.roots.filter((root) => root !== shas[0]);
      return guestOk(JSON.stringify({ Outcome: 'ok' }));
    default:
      return guestOk(JSON.stringify({ Outcome: 'ok' }));
  }
}

export type GuestBehavior = (
  script: string,
  credential: WindowsGuestCredential,
) => WindowsGuestResult | Error;

/** Routes a guest script to the canned response for whichever structural check it is. */
export function structuralChecksBehavior(
  overrides: Partial<Record<string, WindowsGuestResult | Error>> = {},
  share: ShareGuest = shareGuest(),
  trust: TrustGuest = trustGuest(),
): GuestBehavior {
  return (script) => {
    if (shareOperation(script)) return shareAnswer(script, share);
    if (trustOperation(script)) return trustAnswer(script, trust);
    if (script.startsWith(ISOLATED_PROBE_HEADER)) {
      return overrides.isolated ?? guestOk(JSON.stringify(isolatedFacts()));
    }
    const key =
      script === PLATFORM_SCRIPT
        ? 'platform'
        : script === ADMINISTRATOR_SCRIPT
          ? 'admin'
          : script === PENDING_REBOOT_SCRIPT
            ? 'pending'
            : script === WINGET_SCRIPT
              ? 'winget'
              : script.includes('IsInRole')
                ? 'elevation'
                : 'probe';
    if (key === 'probe') return guestOk('ready');
    return overrides[key] ?? SUPPORTED_GUEST_RESPONSES[key];
  };
}

export interface FakeExecutors {
  create(options: { vmName: string; credential: WindowsGuestCredential }): WindowsGuestExecutor;
  created: {
    vmName: string;
    credential: WindowsGuestCredential;
    disposed: boolean;
    scripts: string[];
    timeouts: number[];
  }[];
}

/** An executor factory whose executors answer through `behavior`, keyed by the credential they were made with. */
export function fakeExecutors(behavior: GuestBehavior): FakeExecutors {
  const created: FakeExecutors['created'] = [];
  return {
    created,
    create(options) {
      const record = {
        ...options,
        disposed: false,
        scripts: [] as string[],
        timeouts: [] as number[],
      };
      created.push(record);
      return {
        vmName: options.vmName,
        async invoke(script, invokeOptions) {
          record.scripts.push(script);
          record.timeouts.push(invokeOptions.timeoutMs);
          const result = behavior(script, options.credential);
          if (result instanceof Error) throw result;
          return result;
        },
        async drainCancelled() {},
        async dispose() {
          record.disposed = true;
        },
      };
    },
  };
}

export const authRejection = (): WindowsGuestError =>
  new WindowsGuestError('authentication', 'The guest rejected the credential.');

/** A fake clock whose sleep advances time instead of waiting; an aborted sleep returns at once. */
export function fakeClock(): WindowsSetupClock & { time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    async sleep(ms: number, signal?: AbortSignal) {
      if (signal?.aborted) return;
      clock.time += ms;
    },
  };
  return clock;
}

const flowStep = (directory: string, filename: string): GuestScript => ({
  path: `${SHARE_DIR}\\${directory}\\${filename}`,
  filename,
  slug: /^\d{2}-(.+)\.ps1$/i.exec(filename)![1],
});

/** The generated share's step plans the fake host discovers by default. */
export const FLOW_STEP_PLANS: WindowsStepPlans = {
  pre: [
    flowStep('pre-scripts', '01-install-packages.ps1'),
    flowStep('pre-scripts', '02-install-pnpm.ps1'),
    flowStep('pre-scripts', '03-configure-network.ps1'),
  ],
  post: [flowStep('post-scripts', '01-auth-config.ps1')],
};

export const discoverFlowStepPlans = (): WindowsStepPlanResult => ({
  ok: true,
  plans: FLOW_STEP_PLANS,
});

/** The step filename a step-runner wrapper script was built for, or undefined for any other script. */
export function stepFilenameOf(script: string): string | undefined {
  const path =
    /\$stepPath = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/.exec(
      script,
    )?.[1];
  if (!path) return undefined;
  return Buffer.from(path, 'base64').toString('utf8').split('\\').pop();
}

/** The directory (`pre-scripts` or `post-scripts`) and host address a wrapper was built for. */
export function stepLocationOf(script: string): { hostIp: string; directory: string } | undefined {
  const dir =
    /\$phaseDirectory = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/.exec(
      script,
    )?.[1];
  if (!dir) return undefined;
  const parts = Buffer.from(dir, 'base64').toString('utf8').split('\\').filter(Boolean);
  return { hostIp: parts[0], directory: parts[2] };
}
