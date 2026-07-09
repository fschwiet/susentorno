# VM Egress Host Forwarder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the sandbox VM's `:80`/`:443` traffic through a native userspace TCP forwarder owned by `run-proxy` that pipes to loopback (where Envoy is published), bypassing Docker Desktop's slow external-interface port-forward relay.

**Architecture:** `run-proxy` (Node) starts one `net.Server` per port on the VMware host-only adapter IP and pipes each connection to `127.0.0.1:<port>`, where `docker-compose` now publishes Envoy (loopback-only). The forwarder is byte-transparent TCP, so it serves `:80` HTTP, `:443` SNI passthrough, and `:443` terminate identically. Envoy's config is unchanged.

**Tech Stack:** TypeScript (ESM, Node ≥18), `node:net`, `node:os`, `commander`, `execa`, Vitest.

## Global Constraints

- Node ≥18 (`package.json` `engines.node`); `os.NetworkInterfaceInfo.family` is the string `'IPv4'`.
- Test framework is Vitest (`describe`/`it`/`expect`); unit tests run via `pnpm test:unit`.
- Prettier + ESLint gate `pnpm test`; run `pnpm format` before committing.
- Default VMware host-only adapter name is `"VMware Network Adapter VMnet1"` (must match `templates/proxy/host-allow-vm-inbound.ps1`).
- Envoy host ports come from `ENVOY_HTTP_PORT` (default `80`) and `ENVOY_HTTPS_PORT` (default `443`); the forwarder and `docker-compose` must agree on them.
- Forward upstream target host is always `127.0.0.1`.
- Fail fast: if forwarding is enabled but no listen address can be determined, print a clear error and exit non-zero — never run silently without forwarding.
- Spec: `docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md`.

---

### Task 1: Adapter IP discovery — `resolveForwardListenAddress`

**Files:**
- Create: `src/runProxy/forwarder.ts`
- Test: `tests/unit/runProxy/forwarder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_VMNET_ADAPTER: string` = `'VMware Network Adapter VMnet1'`
  - `resolveForwardListenAddress(adapterName?: string, interfaces?: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>): string | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/forwarder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  DEFAULT_VMNET_ADAPTER,
  resolveForwardListenAddress,
} from '../../../src/runProxy/forwarder';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('resolveForwardListenAddress', () => {
  it('returns the non-internal IPv4 of the named adapter', () => {
    const interfaces = {
      'VMware Network Adapter VMnet1': [ipv4('192.168.241.1')],
      'Wi-Fi': [ipv4('10.0.0.5')],
    };
    expect(resolveForwardListenAddress(DEFAULT_VMNET_ADAPTER, interfaces)).toBe('192.168.241.1');
  });

  it('returns null when the adapter is absent', () => {
    expect(resolveForwardListenAddress(DEFAULT_VMNET_ADAPTER, { 'Wi-Fi': [ipv4('10.0.0.5')] })).toBeNull();
  });

  it('skips internal and IPv6 addresses', () => {
    const interfaces = {
      'VMware Network Adapter VMnet1': [
        { ...ipv4('127.0.0.1', true) },
        { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fe80::1/64', scopeid: 0 } as NetworkInterfaceInfo,
        ipv4('192.168.241.1'),
      ],
    };
    expect(resolveForwardListenAddress(DEFAULT_VMNET_ADAPTER, interfaces)).toBe('192.168.241.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/runProxy/forwarder.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/forwarder` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/runProxy/forwarder.ts`:

```ts
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export const DEFAULT_VMNET_ADAPTER = 'VMware Network Adapter VMnet1';

/**
 * IPv4 address of the VMware host-only adapter to forward from, or null if the
 * adapter is not present. `interfaces` is injectable for testing.
 */
export function resolveForwardListenAddress(
  adapterName: string = DEFAULT_VMNET_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const addrs = interfaces[adapterName];
  if (!addrs) return null;
  for (const a of addrs) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/runProxy/forwarder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/forwarder.ts tests/unit/runProxy/forwarder.test.ts
git commit -m "feat: resolve VMware host-only adapter IP for the egress forwarder"
```

---

### Task 2: The forwarder — `startForwarder`

**Files:**
- Modify: `src/runProxy/forwarder.ts`
- Test: `tests/unit/runProxy/forwarder.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (same file, independent export).
- Produces:
  - `interface ForwardRule { listenPort: number; connectPort: number; }`
  - `interface ForwarderOptions { listenAddress: string; connectHost?: string; rules: ForwardRule[]; }`
  - `interface ForwarderHandle { close(): Promise<void>; }`
  - `startForwarder(opts: ForwarderOptions): Promise<ForwarderHandle>` — listens on `listenAddress:listenPort` for each rule, pipes to `connectHost` (default `127.0.0.1`) `:connectPort`. Rejects if any listener fails to bind (and closes any it already opened).

Note: `listenPort`/`connectPort` are separate so tests can run entirely on `127.0.0.1` with distinct ports (avoiding the listen==connect same-socket loop). Production uses equal ports (`listenPort === connectPort`).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/runProxy/forwarder.test.ts`:

```ts
import net from 'node:net';
import { startForwarder } from '../../../src/runProxy/forwarder';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Echo server on 127.0.0.1 that upper-cases whatever it receives. */
function startEcho(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(d.toString().toUpperCase()));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let out = '';
    c.on('data', (d) => {
      out += d.toString();
      c.end();
    });
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

describe('startForwarder', () => {
  it('pipes bytes through to the upstream target and back', async () => {
    const echo = await startEcho();
    const listenPort = await freePort();
    const handle = await startForwarder({
      listenAddress: '127.0.0.1',
      rules: [{ listenPort, connectPort: echo.port }],
    });

    expect(await roundTrip(listenPort, 'hello')).toBe('HELLO');

    await handle.close();
    await echo.close();
  });

  it('closes the client socket when the upstream target is down', async () => {
    const listenPort = await freePort();
    const deadPort = await freePort(); // nothing listening here
    const handle = await startForwarder({
      listenAddress: '127.0.0.1',
      rules: [{ listenPort, connectPort: deadPort }],
    });

    await new Promise<void>((resolve, reject) => {
      const c = net.connect(listenPort, '127.0.0.1', () => c.write('x'));
      c.on('close', () => resolve());
      c.on('error', () => resolve()); // ECONNRESET is also acceptable
      setTimeout(() => reject(new Error('client was not closed')), 2000);
    });

    await handle.close();
  });

  it('close() releases the listener so the port can be rebound', async () => {
    const listenPort = await freePort();
    const echo = await startEcho();
    const handle = await startForwarder({
      listenAddress: '127.0.0.1',
      rules: [{ listenPort, connectPort: echo.port }],
    });
    await handle.close();

    // Rebinding the same port must now succeed.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(listenPort, '127.0.0.1', () => s.close(() => resolve()));
    });
    await echo.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/runProxy/forwarder.test.ts`
Expected: FAIL — `startForwarder` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `src/runProxy/forwarder.ts`:

```ts
import net from 'node:net';

export interface ForwardRule {
  listenPort: number;
  connectPort: number;
}

export interface ForwarderOptions {
  listenAddress: string;
  connectHost?: string;
  rules: ForwardRule[];
}

export interface ForwarderHandle {
  close(): Promise<void>;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Start one TCP forwarder per rule: accept on `listenAddress:listenPort` and pipe
 * each connection to `connectHost:connectPort` (connectHost defaults to loopback).
 * Byte-transparent; serves HTTP, TLS passthrough, and TLS-terminate alike.
 */
export function startForwarder(opts: ForwarderOptions): Promise<ForwarderHandle> {
  const connectHost = opts.connectHost ?? '127.0.0.1';
  const servers: net.Server[] = [];

  const startOne = (rule: ForwardRule): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        const upstream = net.connect(rule.connectPort, connectHost);
        const teardown = (): void => {
          client.destroy();
          upstream.destroy();
        };
        upstream.on('error', teardown);
        client.on('error', teardown);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.once('error', reject);
      server.listen(rule.listenPort, opts.listenAddress, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  return (async () => {
    try {
      for (const rule of opts.rules) {
        servers.push(await startOne(rule));
      }
    } catch (err) {
      await Promise.all(servers.map(closeServer));
      throw err;
    }
    return {
      close: async () => {
        await Promise.all(servers.map(closeServer));
      },
    };
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/runProxy/forwarder.test.ts`
Expected: PASS (6 tests total: 3 from Task 1 + 3 here).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/forwarder.ts tests/unit/runProxy/forwarder.test.ts
git commit -m "feat: add byte-transparent TCP forwarder for VM egress"
```

---

### Task 3: Forwarder decision + wire into `run-proxy`

**Files:**
- Modify: `src/runProxy/forwarder.ts`
- Modify: `src/commands/runProxy.ts`
- Modify: `tests/integration/runProxy.test.ts:113` (add `--no-forward` to the run-proxy invocation)
- Modify: `technical-notes.md`
- Test: `tests/unit/runProxy/planForwarder.test.ts`

**Interfaces:**
- Consumes: `ForwardRule`, `resolveForwardListenAddress`, `startForwarder`, `ForwarderHandle` (Tasks 1–2).
- Produces:
  - `interface ForwarderPlanInput { noForward: boolean; forwardListen?: string; httpPort: number; httpsPort: number; }`
  - `type ForwarderPlan = { kind: 'disabled' } | { kind: 'error'; message: string } | { kind: 'start'; listenAddress: string; rules: ForwardRule[] }`
  - `planForwarder(input: ForwarderPlanInput, resolveAddress: () => string | null): ForwarderPlan`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/planForwarder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planForwarder } from '../../../src/runProxy/forwarder';

const base = { noForward: false, httpPort: 80, httpsPort: 443 };

describe('planForwarder', () => {
  it('is disabled when noForward is set', () => {
    expect(planForwarder({ ...base, noForward: true }, () => '192.168.241.1')).toEqual({
      kind: 'disabled',
    });
  });

  it('starts with same-port rules when an address is resolved', () => {
    expect(planForwarder(base, () => '192.168.241.1')).toEqual({
      kind: 'start',
      listenAddress: '192.168.241.1',
      rules: [
        { listenPort: 80, connectPort: 80 },
        { listenPort: 443, connectPort: 443 },
      ],
    });
  });

  it('prefers an explicit forwardListen over discovery', () => {
    const plan = planForwarder({ ...base, forwardListen: '10.1.2.3' }, () => '192.168.241.1');
    expect(plan).toMatchObject({ kind: 'start', listenAddress: '10.1.2.3' });
  });

  it('errors when enabled but no address can be resolved', () => {
    const plan = planForwarder(base, () => null);
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') expect(plan.message).toContain('--forward-listen');
  });

  it('honors custom ports', () => {
    expect(planForwarder({ ...base, httpPort: 8080, httpsPort: 8443 }, () => '10.0.0.1')).toEqual({
      kind: 'start',
      listenAddress: '10.0.0.1',
      rules: [
        { listenPort: 8080, connectPort: 8080 },
        { listenPort: 8443, connectPort: 8443 },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/runProxy/planForwarder.test.ts`
Expected: FAIL — `planForwarder` is not exported.

- [ ] **Step 3: Add `planForwarder` to `forwarder.ts`**

Append to `src/runProxy/forwarder.ts`:

```ts
export interface ForwarderPlanInput {
  noForward: boolean;
  forwardListen?: string;
  httpPort: number;
  httpsPort: number;
}

export type ForwarderPlan =
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'start'; listenAddress: string; rules: ForwardRule[] };

/**
 * Decide whether/how to start the forwarder from CLI options. Pure and testable;
 * `resolveAddress` is called only when discovery is needed.
 */
export function planForwarder(
  input: ForwarderPlanInput,
  resolveAddress: () => string | null,
): ForwarderPlan {
  if (input.noForward) return { kind: 'disabled' };
  const listenAddress = input.forwardListen ?? resolveAddress();
  if (!listenAddress) {
    return {
      kind: 'error',
      message:
        'could not find the VMware host-only adapter IP to forward from. ' +
        'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
    };
  }
  return {
    kind: 'start',
    listenAddress,
    rules: [
      { listenPort: input.httpPort, connectPort: input.httpPort },
      { listenPort: input.httpsPort, connectPort: input.httpsPort },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/runProxy/planForwarder.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the forwarder into the `run-proxy` command**

In `src/commands/runProxy.ts`:

Add to the imports at the top:

```ts
import {
  planForwarder,
  resolveForwardListenAddress,
  startForwarder,
  type ForwarderHandle,
} from '../runProxy/forwarder';
```

Add three fields to the `RunProxyOptions` interface:

```ts
  forward: boolean;
  forwardListen?: string;
  forwardPorts?: string;
```

Add three `.option(...)` calls to the command definition (after `--no-refresh`):

```ts
    .option('--no-forward', 'do not forward the VMware host-only interface to loopback')
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the VMware host-only adapter IP)',
    )
    .option(
      '--forward-ports <http,https>',
      'ports to forward (default: ENVOY_HTTP_PORT,ENVOY_HTTPS_PORT or 80,443)',
    )
```

In the `.action(async (options) => { ... })` body, immediately before the `const exitCode = await runProxyLoop(...)` line, insert the forwarder startup:

```ts
      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];

      let forwarder: ForwarderHandle | null = null;
      const plan = planForwarder(
        {
          noForward: !options.forward,
          forwardListen: options.forwardListen,
          httpPort,
          httpsPort,
        },
        () => resolveForwardListenAddress(),
      );
      if (plan.kind === 'error') {
        console.error(`run-proxy: ${plan.message}`);
        process.exitCode = 1;
        return;
      }
      if (plan.kind === 'start') {
        try {
          forwarder = await startForwarder({ listenAddress: plan.listenAddress, rules: plan.rules });
          console.log(
            `run-proxy: forwarding ${plan.listenAddress}:${httpPort}/${httpsPort} -> 127.0.0.1`,
          );
        } catch (err) {
          console.error(`run-proxy: failed to start forwarder on ${plan.listenAddress}: ${String(err)}`);
          process.exitCode = 1;
          return;
        }
      }
```

Wrap the existing `runProxyLoop` call so the forwarder is always closed. Replace:

```ts
      const exitCode = await runProxyLoop(
        {
          credentialsPath: options.credentials,
          secretPath,
          serviceName: options.service,
          refreshWindowMs: Number(options.refreshWindow) * 60_000,
          retryIntervalMs: Number(options.retryInterval) * 60_000,
          maxAttempts: Number(options.maxAttempts),
          refreshEnabled: options.refresh,
        },
        deps,
      );

      process.exitCode = exitCode;
```

with:

```ts
      try {
        const exitCode = await runProxyLoop(
          {
            credentialsPath: options.credentials,
            secretPath,
            serviceName: options.service,
            refreshWindowMs: Number(options.refreshWindow) * 60_000,
            retryIntervalMs: Number(options.retryInterval) * 60_000,
            maxAttempts: Number(options.maxAttempts),
            refreshEnabled: options.refresh,
          },
          deps,
        );
        process.exitCode = exitCode;
      } finally {
        await forwarder?.close();
      }
```

(`commander`'s `--no-forward` sets `options.forward = false`; the default is `true`.)

- [ ] **Step 6: Keep the integration test green — pass `--no-forward`**

In `tests/integration/runProxy.test.ts`, the run-proxy invocation (currently around line 113) is:

```ts
  proxyProc = execa(
    'node',
    [cliPath, 'run-proxy', '--no-refresh', '--credentials', credentialsPath],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );
```

Change the argument array to include `--no-forward` (the test hits Envoy on `127.0.0.1` directly and must not try to bind a host-only adapter that CI lacks):

```ts
  proxyProc = execa(
    'node',
    [cliPath, 'run-proxy', '--no-refresh', '--no-forward', '--credentials', credentialsPath],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );
```

- [ ] **Step 7: Document the forwarder in `technical-notes.md`**

Append a short section to `technical-notes.md`:

```markdown
## VM egress goes through run-proxy's host forwarder

Docker Desktop's published-port relay (WSL2 backend) accepts connections arriving
on the VMware host-only interface slowly and unreliably, while loopback
connections to the same Envoy ports are instant. So `docker-compose` publishes
Envoy on `127.0.0.1` only, and `run-proxy` runs a byte-transparent TCP forwarder
on the host-only adapter IP that pipes `:80`/`:443` to `127.0.0.1`. Forwarding is
active only while `run-proxy` runs (which is required anyway for token freshness).
Disable it with `--no-forward`; override the bind IP with `--forward-listen <ip>`.
See docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md.
```

- [ ] **Step 8: Verify unit + build + typecheck**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test:unit`
Expected: PASS (all unit suites, including the new forwarder + planForwarder tests).

- [ ] **Step 9: Commit**

```bash
git add src/runProxy/forwarder.ts src/commands/runProxy.ts tests/unit/runProxy/planForwarder.test.ts tests/integration/runProxy.test.ts technical-notes.md
git commit -m "feat: run-proxy forwards the VMware host-only interface to loopback"
```

---

### Task 4: Publish Envoy on loopback only

**Files:**
- Modify: `templates/proxy/docker-compose.yml:8-11`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `docker-compose.yml` binds published ports to `127.0.0.1`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/templates.test.ts` inside the `describe('templates', ...)` block:

```ts
  it('publishes Envoy on loopback only so the run-proxy forwarder owns the host-only interface', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('127.0.0.1:${ENVOY_HTTPS_PORT:-443}:443');
    expect(compose).toContain('127.0.0.1:${ENVOY_HTTP_PORT:-80}:80');
    expect(compose).toContain('127.0.0.1:${ENVOY_ADMIN_PORT:-9901}:9901');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/templates.test.ts`
Expected: FAIL — compose still contains `'${ENVOY_HTTPS_PORT:-443}:443'` without the `127.0.0.1:` prefix.

- [ ] **Step 3: Update the compose template**

In `templates/proxy/docker-compose.yml`, replace the `ports:` block:

```yaml
    ports:
      - '${ENVOY_HTTPS_PORT:-443}:443'
      - '${ENVOY_HTTP_PORT:-80}:80'
      - '${ENVOY_ADMIN_PORT:-9901}:9901'
```

with:

```yaml
    ports:
      - '127.0.0.1:${ENVOY_HTTPS_PORT:-443}:443'
      - '127.0.0.1:${ENVOY_HTTP_PORT:-80}:80'
      - '127.0.0.1:${ENVOY_ADMIN_PORT:-9901}:9901'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/proxy/docker-compose.yml tests/unit/templates.test.ts
git commit -m "feat: publish Envoy on loopback so the forwarder owns the VM-facing ports"
```

---

### Task 5: Catch the failure class in `verify-proxy.ps1`

**Files:**
- Modify: `templates/proxy/verify-proxy.ps1` (insert a section after the `'Live proxy behavior'` section, before `'VM reachability'`)

**Interfaces:**
- Consumes: `$caCert`, `Invoke-CurlCode`, `Add-Pass`/`Add-Fail`/`Add-Warn`, `Write-Section` (already defined in the script).
- Produces: a new "VM-path (forwarder → loopback)" section that reproduces the VM's egress path from the host.

This task is PowerShell (no Vitest coverage); it is verified by running the script on the Windows host with the forwarder up.

- [ ] **Step 1: Add the VM-path section**

In `templates/proxy/verify-proxy.ps1`, immediately after the `$gate` block that ends the `'Live proxy behavior'` section (the line `else { Add-Fail 'credential gate wrong-auth' ... }`) and before `Write-Section 'VM reachability'`, insert:

```powershell
Write-Section 'VM-path (forwarder -> loopback)'

$vmIpCfg = Get-NetIPConfiguration -InterfaceAlias 'VMware Network Adapter VMnet1' -ErrorAction SilentlyContinue
$vmIp = ($vmIpCfg.IPv4Address | Select-Object -First 1).IPAddress
if (-not $vmIp) {
    Add-Warn 'VM-path checks' 'no IPv4 on VMware Network Adapter VMnet1 -- skipping (is the host-only adapter up?)'
}
else {
    foreach ($port in 80, 443) {
        $listen = Get-NetTCPConnection -LocalAddress $vmIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listen) { Add-Pass "forwarder listening on ${vmIp}:$port" }
        else { Add-Fail "forwarder listening on ${vmIp}:$port" "no listener -- is 'configamatron run-proxy' running?" }
    }

    $fwd80 = Invoke-CurlCode @('--resolve', "archive.ubuntu.com:80:$vmIp", '--max-time', '20', 'http://archive.ubuntu.com/')
    if ($fwd80.Exit -eq 0 -and [int]($fwd80.Code) -lt 400) { Add-Pass "allow-listed :80 via ${vmIp} -> $($fwd80.Code)" }
    else { Add-Fail "allow-listed :80 via ${vmIp}" "code=$($fwd80.Code) curlExit=$($fwd80.Exit)" }

    $fwdGate = Invoke-CurlCode @('--cacert', $caCert, '--resolve', "api.anthropic.com:443:$vmIp", '-H', 'Authorization: Bearer not-the-placeholder', '--max-time', '20', 'https://api.anthropic.com/')
    if ($fwdGate.Code -eq '403') { Add-Pass "credential gate via ${vmIp} -> 403" }
    else { Add-Fail "credential gate via ${vmIp}" "expected 403, got code=$($fwdGate.Code) curlExit=$($fwdGate.Exit)" }
}
```

- [ ] **Step 2: Manually verify on the host**

With `configamatron run-proxy` running (which starts the forwarder) and the compose change from Task 4 applied to the environment, run from the environment directory:

Run: `powershell -ExecutionPolicy Bypass -File .configamatron\proxy\verify-proxy.ps1`
Expected: the new `== VM-path (forwarder -> loopback) ==` section shows:
- `PASS forwarder listening on <vmIp>:80`
- `PASS forwarder listening on <vmIp>:443`
- `PASS allow-listed :80 via <vmIp> -> 200`
- `PASS credential gate via <vmIp> -> 403`

(If `run-proxy` is not running, these FAIL by design — that is the regression guard.)

- [ ] **Step 3: Commit**

```bash
git add templates/proxy/verify-proxy.ps1
git commit -m "feat: verify-proxy reproduces the VM egress path so relay regressions fail host-side"
```

---

### Task 6: Full verification & VM end-to-end confirmation

**Files:** none (verification only).

- [ ] **Step 1: Run the full gated test suite**

Run: `pnpm test`
Expected: format, lint, typecheck, unit, build, e2e, and integration all PASS. (Integration now passes `--no-forward`; it must not attempt to bind a host-only adapter.)

- [ ] **Step 2: Rebuild the environment's proxy from templates and restart run-proxy**

On the Windows host, in the environment directory, re-run the proxy setup so the loopback compose change and forwarder take effect (per usage.md — regenerate config if needed, then):

Run: `configamatron run-proxy` (leave running)
Expected: log line `run-proxy: forwarding <vmIp>:80/443 -> 127.0.0.1`.

- [ ] **Step 3: Confirm from the VM**

On the sandbox VM:

Run: `./verify-config.sh`
Expected: the previously failing live-egress checks now PASS:
- `PASS allow-listed :80 archive.ubuntu.com -> 200`
- `PASS allow-listed passthrough :443 pypi.org -> 200`
- `PASS credential gate wrong-auth -> 403`
- overall `0 failed`.

- [ ] **Step 4: Commit any doc touch-ups**

If `usage.md` needs a note that `run-proxy` must stay running for VM egress, add it and:

```bash
git add usage.md
git commit -m "docs: note run-proxy owns the VM egress forwarder"
```
