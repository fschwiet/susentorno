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
import type { WindowsSetupClock } from '../../../../src/guestSetup/windows/setupFlow';

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
  state: { vmState: string; switchName: string | null; adapters: number };
}

/** A stateful stand-in for the Hyper-V and networking cmdlets the setup flow runs on the host. */
export function fakeHyperV(
  initial: Partial<FakeHyperV['state']> = {},
  options: {
    events?: EventLog;
    stopNeverCompletes?: boolean;
    listeners?: boolean;
    sharePath?: string;
  } = {},
): FakeHyperV {
  const state = {
    vmState: 'Off',
    switchName: 'Default Switch' as string | null,
    adapters: 1,
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
      if (command.startsWith('Get-NetUDPEndpoint')) {
        return options.listeners === false ? ok('') : ok('bound');
      }
      if (command.startsWith('Get-SmbShare')) {
        return ok(
          JSON.stringify({ Name: 'vm-shared-windows', Path: options.sharePath ?? SHARE_DIR }),
        );
      }
      if (command.startsWith('Stop-VM')) {
        if (!options.stopNeverCompletes) state.vmState = 'Off';
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

export type GuestBehavior = (
  script: string,
  credential: WindowsGuestCredential,
) => WindowsGuestResult | Error;

/** Routes a guest script to the canned response for whichever structural check it is. */
export function structuralChecksBehavior(
  overrides: Partial<Record<string, WindowsGuestResult | Error>> = {},
): GuestBehavior {
  return (script) => {
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
