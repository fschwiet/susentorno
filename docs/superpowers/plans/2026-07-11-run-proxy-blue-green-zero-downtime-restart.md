# Blue-Green Zero-Downtime Proxy Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `run-proxy` apply credential rotations and allowlist edits with zero downtime for new connections, by swapping between two Envoy containers (blue/green) behind a stable forwarder instead of force-recreating one container in place.

**Architecture:** `run-proxy` becomes the stable front door. It runs a gateway forwarder that always listens on the public ports (`127.0.0.1:443/:80`, or the test overrides) and connects to whichever color is live. Each color is a separate compose service publishing its own dynamically-allocated host ports; both run identical Envoy internals on 443/80/9901. On a change, `run-proxy` brings up the idle color fresh, waits for its own admin `/ready`, flips the forwarder's connect target, then drains and stops the old color.

**Tech Stack:** TypeScript (ESM), Node ≥18, vitest, execa, Docker Compose v2, commander.

## Global Constraints

- **Commit directly to `main`.** No feature branches for this repo.
- **Generous commit messages:** narrative why + evidence for each non-trivial change.
- **`envoyConfig.ts` is NOT modified.** Both colors run identical Envoy internals on container ports 443/80/9901; only host-published ports differ.
- **Docker recreates must be driven from Windows / git-bash**, never from a `/mnt/c` WSL cwd (the Windows daemon can't resolve `./` bind-mounts from there and silently no-ops).
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Unit tests: `pnpm exec vitest run <file>`. Integration: `pnpm test:integration` (builds `dist/` first via the config's own steps — run `pnpm build` before if invoking a single file). VM e2e: `pnpm test:vm`.
- The shared vocabulary of run-proxy stdout lines that tests gate on:
  - startup success: `run-proxy: watching credentials and allowlist; proxy is serving the current token (<color>)`
  - swap begin: `run-proxy: restarting proxy — <reasons>`
  - swap success: `run-proxy: swap complete — now serving <color>`
  - swap ready-fail: `run-proxy: new proxy (<color>) did not become ready — keeping the current proxy`
  - swap bring-up-fail: `run-proxy: could not start the new proxy (<color>) — keeping the current proxy: <err>`

---

## File Structure

**New files:**
- `src/runProxy/allocateColorPorts.ts` — allocate three distinct free loopback ports for a color.
- `src/runProxy/waitColorReady.ts` — poll a color's admin `/ready` until 200 or timeout.
- `src/runProxy/gateway.ts` — the switchable, connection-tracking forwarder (setTarget / drain / close).
- `src/runProxy/colorContainer.ts` — thin execa wrappers: `bringUpColor`, `stopColor`.
- `tests/unit/runProxy/allocateColorPorts.test.ts`, `waitColorReady.test.ts`, `gateway.test.ts`.

**Modified files:**
- `templates/proxy/docker-compose.yml` — two services `envoy_blue` / `envoy_green` via a shared YAML anchor.
- `tests/unit/templates.test.ts` — assert the two-service topology.
- `src/runProxy/types.ts` — add `Color`, `ColorPorts`, `otherColor`.
- `src/runProxy/runProxyLoop.ts` — new deps; startup ready-gate; swap logic in `drainRestarts`.
- `tests/unit/runProxy/runProxyLoop.test.ts` — new harness + swap tests.
- `src/commands/runProxy.ts` — build the gateway, wire the new deps, color→service log stream, drop `--service`, update forwarder-address logic; delete now-dead `startForwarder`/`planForwarder` usage.
- `src/runProxy/forwarder.ts` — remove `startForwarder`/`planForwarder`/`ForwarderPlan` (superseded by gateway); keep `resolveForwardListenAddress`.
- `tests/unit/runProxy/forwarder.test.ts` — drop the `startForwarder` describe block; keep `resolveForwardListenAddress` tests.
- `tests/integration/runProxy.test.ts` — gate on stdout + secret file; assert color alternation.
- `tests/proxyStack.ts` — wait on the startup stdout line; drop admin/container-id helpers.
- `tests/vm/vm.test.ts` — gate restart tests on `swap complete`; drop the deleted helpers.
- `templates/proxy/verify-proxy.ps1` — match either color's container.

---

## Task 1: Two-service compose template

**Files:**
- Modify: `templates/proxy/docker-compose.yml`
- Test: `tests/unit/templates.test.ts:50-55`

**Interfaces:**
- Produces: a compose project `configamatron` with services `envoy_blue` and `envoy_green`, each publishing `127.0.0.1:${ENVOY_<COLOR>_HTTPS_PORT:-}:443`, `:${..._HTTP_PORT:-}:80`, `:${..._ADMIN_PORT:-}:9901`. Empty (`:-`) default → Docker assigns an ephemeral host port, valid for the color not currently being managed.

- [ ] **Step 1: Update the template test to describe two services**

Replace the test at `tests/unit/templates.test.ts:50-55` with:

```typescript
  it('defines both blue and green Envoy services publishing on loopback', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('container_name: configamatron-envoy-blue');
    expect(compose).toContain('container_name: configamatron-envoy-green');
    // Host ports are injected per-color by run-proxy; unset -> ephemeral.
    expect(compose).toContain('127.0.0.1:${ENVOY_BLUE_HTTPS_PORT:-}:443');
    expect(compose).toContain('127.0.0.1:${ENVOY_GREEN_HTTPS_PORT:-}:443');
    expect(compose).toContain('127.0.0.1:${ENVOY_BLUE_ADMIN_PORT:-}:9901');
    expect(compose).toContain('127.0.0.1:${ENVOY_GREEN_ADMIN_PORT:-}:9901');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: FAIL — the current single-service template has no `container_name` / per-color ports.

- [ ] **Step 3: Rewrite the compose template**

Replace the entire contents of `templates/proxy/docker-compose.yml` with:

```yaml
name: configamatron

x-envoy: &envoy
  image: envoyproxy/envoy:v1.31-latest
  restart: unless-stopped
  extra_hosts:
    - 'host.docker.internal:host-gateway'
  volumes:
    - ./envoy.yaml:/etc/envoy/envoy.yaml:ro
    - ./gate.lua:/etc/envoy/gate.lua:ro
    - ./ca:/etc/envoy/ca:ro
    - ./secrets:/etc/envoy/secrets:ro
  command: ['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info']

services:
  envoy_blue:
    <<: *envoy
    container_name: configamatron-envoy-blue
    ports:
      - '127.0.0.1:${ENVOY_BLUE_HTTPS_PORT:-}:443'
      - '127.0.0.1:${ENVOY_BLUE_HTTP_PORT:-}:80'
      - '127.0.0.1:${ENVOY_BLUE_ADMIN_PORT:-}:9901'
  envoy_green:
    <<: *envoy
    container_name: configamatron-envoy-green
    ports:
      - '127.0.0.1:${ENVOY_GREEN_HTTPS_PORT:-}:443'
      - '127.0.0.1:${ENVOY_GREEN_HTTP_PORT:-}:80'
      - '127.0.0.1:${ENVOY_GREEN_ADMIN_PORT:-}:9901'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Sanity-check compose parses with one color's ports set**

Run (git-bash, from repo root):
```bash
ENVOY_BLUE_HTTPS_PORT=15443 ENVOY_BLUE_HTTP_PORT=15080 ENVOY_BLUE_ADMIN_PORT=15901 \
  docker compose -f templates/proxy/docker-compose.yml config >/dev/null && echo OK
```
Expected: `OK` (no interpolation error; green's empty ports resolve to ephemeral).

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/docker-compose.yml tests/unit/templates.test.ts
git commit -m "feat(proxy): blue/green compose services for zero-downtime swaps"
```

---

## Task 2: Color types + port allocation

**Files:**
- Modify: `src/runProxy/types.ts`
- Create: `src/runProxy/allocateColorPorts.ts`
- Test: `tests/unit/runProxy/allocateColorPorts.test.ts`

**Interfaces:**
- Produces:
  - `type Color = 'blue' | 'green'`
  - `interface ColorPorts { httpsPort: number; httpPort: number; adminPort: number }`
  - `function otherColor(c: Color): Color`
  - `function allocateColorPorts(): Promise<ColorPorts>` — three distinct, currently-free loopback ports.

- [ ] **Step 1: Add the types**

Append to `src/runProxy/types.ts`:

```typescript
export type Color = 'blue' | 'green';

export interface ColorPorts {
  httpsPort: number;
  httpPort: number;
  adminPort: number;
}

export function otherColor(color: Color): Color {
  return color === 'blue' ? 'green' : 'blue';
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/runProxy/allocateColorPorts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { allocateColorPorts } from '../../../src/runProxy/allocateColorPorts';

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

describe('allocateColorPorts', () => {
  it('returns three distinct free loopback ports', async () => {
    const ports = await allocateColorPorts();
    const values = [ports.httpsPort, ports.httpPort, ports.adminPort];
    expect(new Set(values).size).toBe(3);
    for (const p of values) {
      expect(p).toBeGreaterThan(0);
      expect(await canBind(p)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/allocateColorPorts.test.ts`
Expected: FAIL — module `allocateColorPorts` does not exist.

- [ ] **Step 4: Implement**

Create `src/runProxy/allocateColorPorts.ts`:

```typescript
import net from 'node:net';
import type { ColorPorts } from './types';

/** Open an ephemeral loopback server and resolve with it (still listening). */
function openEphemeral(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/**
 * Allocate three distinct free loopback ports. All three sockets are held open
 * at once before any is read, so the OS cannot hand out the same port twice.
 * There is an unavoidable TOCTOU gap between closing here and Docker publishing;
 * it is small and standard for ephemeral-port handoff.
 */
export async function allocateColorPorts(): Promise<ColorPorts> {
  const servers = await Promise.all([openEphemeral(), openEphemeral(), openEphemeral()]);
  const [httpsPort, httpPort, adminPort] = servers.map(
    (s) => (s.address() as net.AddressInfo).port,
  );
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return { httpsPort, httpPort, adminPort };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/allocateColorPorts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/types.ts src/runProxy/allocateColorPorts.ts tests/unit/runProxy/allocateColorPorts.test.ts
git commit -m "feat(run-proxy): Color/ColorPorts types and free-loopback-port allocation"
```

---

## Task 3: Admin readiness poll

**Files:**
- Create: `src/runProxy/waitColorReady.ts`
- Test: `tests/unit/runProxy/waitColorReady.test.ts`

**Interfaces:**
- Produces:
  - `function adminReadyOnce(adminPort: number): Promise<boolean>` — one GET of `127.0.0.1:adminPort/ready`, true iff HTTP 200.
  - `function waitColorReady(adminPort: number, timeoutMs: number, sleepMs?: number): Promise<boolean>` — poll until 200 (true) or deadline (false).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/waitColorReady.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitColorReady } from '../../../src/runProxy/waitColorReady';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function listen(handler: (n: number) => number): Promise<number> {
  let hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = handler(hits);
    res.end();
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe('waitColorReady', () => {
  it('resolves true once /ready returns 200 (after a few 503s)', async () => {
    const port = await listen((hits) => (hits >= 3 ? 200 : 503));
    expect(await waitColorReady(port, 5000, 20)).toBe(true);
  });

  it('resolves false when readiness never arrives before the timeout', async () => {
    const port = await listen(() => 503);
    expect(await waitColorReady(port, 300, 20)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/runProxy/waitColorReady.ts`:

```typescript
import { request } from 'node:http';

/** One probe of a color's admin /ready; true iff it answers HTTP 200. */
export function adminReadyOnce(adminPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: adminPort, path: '/ready', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a color's OWN admin /ready until it answers 200 (returns true) or the
 * timeout elapses (returns false). Because each color has its own admin port,
 * a 200 here means THAT container is serving — unlike the in-place-recreate
 * case where the dying container answered /ready during the swap.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  sleepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(sleepMs);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/waitColorReady.ts tests/unit/runProxy/waitColorReady.test.ts
git commit -m "feat(run-proxy): per-color admin /ready readiness poll"
```

---

## Task 4: Switchable gateway forwarder

**Files:**
- Create: `src/runProxy/gateway.ts`
- Test: `tests/unit/runProxy/gateway.test.ts`

**Interfaces:**
- Produces:
  - `interface GatewayTarget { httpsPort: number; httpPort: number }`
  - `interface GatewayOptions { listenAddresses: string[]; httpsListenPort: number; httpListenPort: number; connectHost?: string; initialTarget?: GatewayTarget | null }`
  - `interface GatewayHandle { setTarget(t: GatewayTarget): void; drain(t: GatewayTarget, timeoutMs: number): Promise<void>; close(): Promise<void> }`
  - `function startGateway(opts: GatewayOptions): Promise<GatewayHandle>`
- Behavior: each incoming connection is piped to the CURRENT target's port (https listener → `target.httpsPort`, http listener → `target.httpPort`), captured at accept time. `setTarget` only affects NEW connections. `drain(t, ms)` resolves once no live connections remain pointed at `t`'s ports, or force-closes them at the timeout. With no target set, incoming connections are dropped.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/runProxy/gateway.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { startGateway } from '../../../src/runProxy/gateway';

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

/** Echo server that prefixes every write with `tag:` so callers can tell targets apart. */
function startTaggedEcho(tag: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(`${tag}:${d.toString()}`));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Send one payload on an already-open socket and resolve with the next chunk. */
function send(sock: net.Socket, payload: string): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(payload);
  });
}

/** Open a fresh connection, send once, resolve with the reply, then close. */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    c.once('data', (d) => {
      resolve(d.toString());
      c.end();
    });
    c.on('error', reject);
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startGateway', () => {
  it('routes new connections to the current target', async () => {
    const echo = await startTaggedEcho('one');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo.port, httpPort: 1 },
    });

    expect(await roundTrip(httpsListen, 'hi')).toBe('one:hi');

    await gw.close();
    await echo.close();
  });

  it('keeps existing connections on the old target after a flip; drain waits for them', async () => {
    const echo1 = await startTaggedEcho('one');
    const echo2 = await startTaggedEcho('two');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo1.port, httpPort: 1 },
    });

    // Long-lived connection bound to echo1.
    const sock = net.connect(httpsListen, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    expect(await send(sock, 'a')).toBe('one:a');

    gw.setTarget({ httpsPort: echo2.port, httpPort: 1 });

    // The pre-flip socket still reaches echo1; a new connection reaches echo2.
    expect(await send(sock, 'b')).toBe('one:b');
    expect(await roundTrip(httpsListen, 'c')).toBe('two:c');

    // Draining echo1 does not resolve while the old socket is open.
    let drained = false;
    const dp = gw.drain({ httpsPort: echo1.port, httpPort: 1 }, 2000).then(() => {
      drained = true;
    });
    await delay(200);
    expect(drained).toBe(false);

    sock.destroy();
    await dp;
    expect(drained).toBe(true);

    await gw.close();
    await echo1.close();
    await echo2.close();
  });

  it('force-closes remaining connections when drain times out', async () => {
    const echo = await startTaggedEcho('one');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo.port, httpPort: 1 },
    });

    const sock = net.connect(httpsListen, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    await send(sock, 'x');

    let closed = false;
    sock.on('close', () => {
      closed = true;
    });

    await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 300);
    expect(closed).toBe(true);

    await gw.close();
    await echo.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/runProxy/gateway.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/runProxy/gateway.ts`:

```typescript
import net from 'node:net';

export interface GatewayTarget {
  httpsPort: number;
  httpPort: number;
}

export interface GatewayOptions {
  /** Addresses to listen on, e.g. ['127.0.0.1'] or ['127.0.0.1', '192.168.241.1']. */
  listenAddresses: string[];
  httpsListenPort: number;
  httpListenPort: number;
  /** Host the active color is published on; defaults to loopback. */
  connectHost?: string;
  /** Target to route to before the first setTarget; null drops connections. */
  initialTarget?: GatewayTarget | null;
}

export interface GatewayHandle {
  setTarget(target: GatewayTarget): void;
  /** Resolve once no connections remain on `target`'s ports, or force-close at timeout. */
  drain(target: GatewayTarget, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

interface Conn {
  client: net.Socket;
  upstream: net.Socket;
  connectPort: number;
}

/**
 * The stable front door. Always listens on the public ports and pipes each
 * connection to whichever color is currently active. A flip (setTarget) only
 * redirects NEW connections; connections already piped to the old color keep
 * flowing until they close or are force-closed by drain — that overlap IS the
 * zero-downtime property.
 */
export function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const connectHost = opts.connectHost ?? '127.0.0.1';
  let target: GatewayTarget | null = opts.initialTarget ?? null;
  const conns = new Set<Conn>();
  const servers: net.Server[] = [];

  const onClient = (client: net.Socket, isHttps: boolean): void => {
    if (!target) {
      client.destroy();
      return;
    }
    const connectPort = isHttps ? target.httpsPort : target.httpPort;
    const upstream = net.connect(connectPort, connectHost);
    const conn: Conn = { client, upstream, connectPort };
    conns.add(conn);
    const teardown = (): void => {
      conns.delete(conn);
      client.destroy();
      upstream.destroy();
    };
    upstream.on('error', teardown);
    client.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const startOne = (address: string, port: number, isHttps: boolean): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((client) => onClient(client, isHttps));
      server.once('error', reject);
      server.listen(port, address, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  const onTarget = (t: GatewayTarget): Conn[] =>
    [...conns].filter((c) => c.connectPort === t.httpsPort || c.connectPort === t.httpPort);

  return (async () => {
    try {
      for (const address of opts.listenAddresses) {
        servers.push(await startOne(address, opts.httpsListenPort, true));
        servers.push(await startOne(address, opts.httpListenPort, false));
      }
    } catch (err) {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      throw err;
    }

    return {
      setTarget: (t: GatewayTarget): void => {
        target = t;
      },
      drain: async (t: GatewayTarget, timeoutMs: number): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (onTarget(t).length > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        for (const c of onTarget(t)) {
          conns.delete(c);
          c.client.destroy();
          c.upstream.destroy();
        }
      },
      close: async (): Promise<void> => {
        for (const c of [...conns]) {
          c.client.destroy();
          c.upstream.destroy();
        }
        conns.clear();
        await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      },
    };
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/gateway.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/gateway.ts tests/unit/runProxy/gateway.test.ts
git commit -m "feat(run-proxy): switchable connection-tracking gateway forwarder with drain"
```

---

## Task 5: Swap orchestration in runProxyLoop

**Files:**
- Modify: `src/runProxy/runProxyLoop.ts`
- Test (full rewrite): `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**
- Consumes: `Color`, `ColorPorts`, `otherColor` from `./types` (Task 2).
- Produces (new `RunProxyDeps` shape — replaces `recreateContainer`, changes `startLogStream`):
  - `allocatePorts: () => Promise<ColorPorts>`
  - `bringUpColor: (color: Color, ports: ColorPorts) => Promise<void>`
  - `waitColorReady: (ports: ColorPorts, timeoutMs: number) => Promise<boolean>`
  - `setActiveBackend: (ports: ColorPorts) => void`
  - `drainBackend: (ports: ColorPorts, timeoutMs: number) => Promise<void>`
  - `stopColor: (color: Color) => Promise<void>`
  - `startLogStream: (color: Color, onLine: (raw: string) => void) => void`
- Produces (new `RunProxyConfig` fields): removes `serviceName`; adds `readyTimeoutMs: number`, `drainTimeoutMs: number`.

- [ ] **Step 1: Update the deps + config interfaces**

In `src/runProxy/runProxyLoop.ts`, update the import at the top:

```typescript
import type { Credentials, NudgeResult, RefreshState, Color, ColorPorts } from './types';
import { otherColor } from './types';
```

Replace the `RunProxyConfig` interface (currently lines 9-18) with:

```typescript
export interface RunProxyConfig {
  credentialsPath: string;
  allowlistPath: string;
  secretPath: string;
  /** How long to wait for a freshly-started color's admin /ready before giving up. */
  readyTimeoutMs: number;
  /** How long to let the old color's connections finish before force-closing them. */
  drainTimeoutMs: number;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}
```

In `RunProxyDeps`, remove the `recreateContainer` line and replace the `startLogStream` line; the container-management block becomes:

```typescript
  /** Allocate three distinct free loopback ports for the next color to bring up. */
  allocatePorts: () => Promise<ColorPorts>;
  /** Force-recreate the given color's container, published on `ports`. */
  bringUpColor: (color: Color, ports: ColorPorts) => Promise<void>;
  /** Poll the color's own admin /ready; true once it serves, false on timeout. */
  waitColorReady: (ports: ColorPorts, timeoutMs: number) => Promise<boolean>;
  /** Point the gateway forwarder at this color's backend ports (the flip). */
  setActiveBackend: (ports: ColorPorts) => void;
  /** Wait for the old color's connections to drain, force-closing at timeout. */
  drainBackend: (ports: ColorPorts, timeoutMs: number) => Promise<void>;
  /** Stop the given color's container. */
  stopColor: (color: Color) => Promise<void>;
```

Change the `startLogStream` dep signature to take the color:

```typescript
  startLogStream: (color: Color, onLine: (raw: string) => void) => void;
```

- [ ] **Step 2: Add swap state and remove the old recreate helper**

Near the other `let` state declarations (currently around lines 51-65), add:

```typescript
    let activeColor: Color = 'blue';
    let activePorts: ColorPorts | null = null;
```

Delete the `recreateWithOneRetry` helper (currently lines 114-126) entirely — it is replaced by the swap logic.

- [ ] **Step 3: Rewrite the restart branch inside `drainRestarts`**

Replace the `if (restartNeeded) { ... }` block (currently lines 270-282) with:

```typescript
          if (restartNeeded && activePorts !== null) {
            deps.log(`run-proxy: restarting proxy — ${reasons.join(', ')}`);
            const idle = otherColor(activeColor);
            const oldColor = activeColor;
            const oldPorts = activePorts;

            const idlePorts = await deps.allocatePorts();
            let broughtUp = true;
            try {
              await deps.bringUpColor(idle, idlePorts);
            } catch (err) {
              broughtUp = false;
              deps.error(
                `run-proxy: could not start the new proxy (${idle}) — keeping the current proxy: ${String(err)}`,
              );
            }
            if (settled) return;

            if (broughtUp) {
              const ready = await deps.waitColorReady(idlePorts, config.readyTimeoutMs);
              if (settled) return;
              if (!ready) {
                deps.error(
                  `run-proxy: new proxy (${idle}) did not become ready — keeping the current proxy`,
                );
                await deps.stopColor(idle).catch(() => {});
              } else {
                // Flip: new connections now go to the freshly-ready color.
                await deps.stopLogStream();
                deps.setActiveBackend(idlePorts);
                activeColor = idle;
                activePorts = idlePorts;
                if (tokenToApply !== null) lastAppliedToken = tokenToApply;
                if (clearUnique) unique.clear();
                deps.startLogStream(idle, onLogLine);
                // Retire the old color once its connections drain (bounded).
                await deps.drainBackend(oldPorts, config.drainTimeoutMs);
                await deps.stopColor(oldColor).catch(() => {});
                deps.log(`run-proxy: swap complete — now serving ${activeColor}`);
              }
            }
          }
```

Note: on a keep-old outcome (`broughtUp` false or not ready), `lastAppliedToken` and `unique` are intentionally left unchanged, and control falls through to the existing `armTimer` block so nudge scheduling continues.

- [ ] **Step 4: Rewrite the startup recreate in `start()`**

Replace the `restarting = true; try { ... } finally { restarting = false; }` block in `start()` (currently lines 335-356) with:

```typescript
      restarting = true; // hold watcher events as pending until the startup bring-up is done
      try {
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
        deps.writeSecret(creds.accessToken, config.secretPath);
        const ports = await deps.allocatePorts();
        try {
          await deps.bringUpColor('blue', ports);
        } catch {
          fatal('docker failed to start the proxy on startup');
          return;
        }
        if (settled) return;
        const ready = await deps.waitColorReady(ports, config.readyTimeoutMs);
        if (settled) return;
        if (!ready) {
          fatal('proxy did not become ready on startup');
          return;
        }
        activeColor = 'blue';
        activePorts = ports;
        deps.setActiveBackend(ports);
        lastAppliedToken = creds.accessToken;
        lastSeenExpiresAt = creds.expiresAt;
        deps.startLogStream('blue', onLogLine);
      } finally {
        restarting = false;
      }
```

Then change the startup "serving" log line (currently line 366) to include the color:

```typescript
      deps.log(
        `run-proxy: watching credentials and allowlist; proxy is serving the current token (${activeColor})`,
      );
```

- [ ] **Step 5: Replace the unit-test harness (full file rewrite)**

Overwrite `tests/unit/runProxy/runProxyLoop.test.ts` with:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runProxyLoop,
  type RunProxyConfig,
  type RunProxyDeps,
} from '../../../src/runProxy/runProxyLoop';
import type { Credentials, ColorPorts } from '../../../src/runProxy/types';

const MIN = 60_000;

const VALID_ALLOWLIST = [
  '# passthrough',
  'pypi.org:443',
  '',
  '# terminate',
  'api.anthropic.com:443',
  '',
].join('\n');

const INVALID_ALLOWLIST = ['# terminate', '*.bad.example.com:443', ''].join('\n');

const PASS_LINE = 'envoy-1  | CFGM|pass|2026-07-10T12:00:00|pypi.org|-|-';
const CRED_LINE =
  'envoy-1  | CFGM|term|2026-07-10T12:00:01|api.anthropic.com|api.anthropic.com|via_upstream';

function baseConfig(overrides: Partial<RunProxyConfig> = {}): RunProxyConfig {
  return {
    credentialsPath: '/fake/.credentials.json',
    allowlistPath: '/fake/allowlist.txt',
    secretPath: '/fake/sds-secret.yaml',
    readyTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

interface Harness {
  deps: RunProxyDeps;
  creds: { value: Credentials };
  allowlist: { value: string | null };
  fireCredentials: () => void;
  fireAllowlist: () => void;
  fireSigint: () => void;
  feedLogLine: (raw: string) => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn>;
    allocatePorts: ReturnType<typeof vi.fn>;
    bringUpColor: ReturnType<typeof vi.fn>;
    waitColorReady: ReturnType<typeof vi.fn>;
    setActiveBackend: ReturnType<typeof vi.fn>;
    drainBackend: ReturnType<typeof vi.fn>;
    stopColor: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn>;
    buildConfig: ReturnType<typeof vi.fn>;
    ensureLeaf: ReturnType<typeof vi.fn>;
    startLogStream: ReturnType<typeof vi.fn>;
    stopLogStream: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  initial: Credentials,
  initialAllowlist: string | null = VALID_ALLOWLIST,
): Harness {
  const creds = { value: initial };
  const allowlist = { value: initialAllowlist };
  let credentialsCb: (() => void) | null = null;
  let allowlistCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  let onLine: ((raw: string) => void) | null = null;
  const watchClose = vi.fn();

  let portSeq = 0;
  const nextPorts = (): ColorPorts => {
    portSeq += 1;
    return { httpsPort: 20000 + portSeq, httpPort: 21000 + portSeq, adminPort: 22000 + portSeq };
  };

  const mocks = {
    writeSecret: vi.fn(),
    allocatePorts: vi.fn(async () => nextPorts()),
    bringUpColor: vi.fn().mockResolvedValue(undefined),
    waitColorReady: vi.fn().mockResolvedValue(true),
    setActiveBackend: vi.fn(),
    drainBackend: vi.fn().mockResolvedValue(undefined),
    stopColor: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    buildConfig: vi.fn(),
    ensureLeaf: vi.fn().mockReturnValue('reused leaf for 1 host(s)'),
    startLogStream: vi.fn((_color: string, cb: (raw: string) => void) => {
      onLine = cb;
    }),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    watchClose,
    log: vi.fn(),
    error: vi.fn(),
  };
  const deps: RunProxyDeps = {
    readCredentials: () => creds.value,
    readAllowlist: () => allowlist.value,
    writeSecret: mocks.writeSecret,
    buildConfig: mocks.buildConfig,
    ensureLeaf: mocks.ensureLeaf,
    allocatePorts: mocks.allocatePorts,
    bringUpColor: mocks.bringUpColor,
    waitColorReady: mocks.waitColorReady,
    setActiveBackend: mocks.setActiveBackend,
    drainBackend: mocks.drainBackend,
    stopColor: mocks.stopColor,
    nudgeRefresh: mocks.nudgeRefresh,
    watch: (path, onEvent) => {
      if (path.endsWith('.credentials.json')) credentialsCb = onEvent;
      else allowlistCb = onEvent;
      return { close: watchClose };
    },
    startLogStream: mocks.startLogStream,
    stopLogStream: mocks.stopLogStream,
    onSigint: (handler) => {
      sigintCb = handler;
    },
    log: mocks.log,
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    allowlist,
    fireCredentials: () => credentialsCb?.(),
    fireAllowlist: () => allowlistCb?.(),
    fireSigint: () => sigintCb?.(),
    feedLogLine: (raw) => onLine?.(raw),
    mocks,
  };
}

/** Flush microtasks + zero-delay timers so the multi-await swap chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProxyLoop startup', () => {
  it('builds config, ensures leaf, writes secret, brings up blue, sets backend, logs', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].terminate).toEqual(['api.anthropic.com:443']);
    expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('blue');
    expect(h.mocks.waitColorReady).toHaveBeenCalledTimes(1);
    expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream.mock.calls[0][0]).toBe('blue');
  });

  it('exits 1 on an invalid allowlist without touching docker', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, INVALID_ALLOWLIST);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('unsupported wildcard syntax'),
    );
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('*.bad.example.com:443'));
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('exits 1 when the allowlist is unreadable', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, null);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('could not read allowlist'));
  });

  it('exits 1 when blue never becomes ready on startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    h.mocks.waitColorReady.mockResolvedValue(false);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('did not become ready on startup'),
    );
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
  });

  it('applies an allowlist change that lands during the startup bring-up', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    void runProxyLoop(baseConfig(), h.deps);
    await flush(); // startup bring-up in flight; both watchers already armed

    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nlate.example.com:443',
    );
    h.fireAllowlist();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // still just the startup one

    release();
    await flush();

    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // startup + coalesced swap
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(2);
    expect(h.mocks.buildConfig.mock.calls[1][0].passthrough).toContain('late.example.com:443');
  });
});

describe('runProxyLoop inline logging', () => {
  it('prints each parsed host+handling once and ignores non-CFGM lines', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();

    h.feedLogLine('[2026-07-10 12:00:00.000][1][info][main] envoy operational line');
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(CRED_LINE);

    expect(h.mocks.log.mock.calls.map((c) => c[0])).toEqual([
      '12:00:00  ALLOW PASS  pypi.org',
      '12:00:01  ALLOW CRED  api.anthropic.com',
    ]);
  });
});

describe('runProxyLoop allowlist changes', () => {
  it('rebuilds config, reissues leaf, swaps to green, and clears unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org now tracked as seen
    h.mocks.buildConfig.mockClear();
    h.mocks.ensureLeaf.mockClear();
    h.mocks.bringUpColor.mockClear();
    h.mocks.log.mockClear();

    h.allowlist.value = VALID_ALLOWLIST.replace('pypi.org:443', 'pypi.org:443\nexample.org:443');
    h.fireAllowlist();
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toContain('example.org:443');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — allowlist changed');
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('green');
    expect(h.mocks.stopLogStream).toHaveBeenCalledTimes(1);
    expect(h.mocks.drainBackend).toHaveBeenCalledTimes(1);
    expect(h.mocks.stopColor).toHaveBeenCalledWith('blue');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(2); // startup(blue) + swap(green)
    expect(h.mocks.startLogStream.mock.calls[1][0]).toBe('green');

    // Unique tracking was cleared: the same host+handling prints again.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });

  it('keeps the previous config on an invalid edit and stays live for the fix', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.buildConfig.mockClear();
    h.mocks.bringUpColor.mockClear();

    h.allowlist.value = INVALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('allowlist has unsupported wildcard syntax, keeping previous config'),
    );
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();

    // The watcher stayed live: fixing the file triggers a fresh swap.
    h.allowlist.value = VALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
  });
});

describe('runProxyLoop credential changes', () => {
  it('propagates a changed token via a swap, preserving unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org tracked as seen
    h.mocks.writeSecret.mockClear();
    h.mocks.bringUpColor.mockClear();
    h.mocks.log.mockClear();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(h.mocks.bringUpColor).toHaveBeenCalledWith('green', expect.anything());
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — credentials changed');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');

    // Unique tracking survived the credential swap.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).not.toHaveBeenCalled();
    h.feedLogLine(CRED_LINE); // a new key still prints (stream is live)
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:01  ALLOW CRED  api.anthropic.com');
  });

  it('alternates the active color across successive swaps', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');

    h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving blue');
    expect(h.mocks.stopColor.mock.calls.map((c) => c[0])).toEqual(['blue', 'green']);
  });

  it('does not swap when the token is unchanged', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.bringUpColor.mockClear();

    h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
    h.fireCredentials();
    await flush();

    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('keeps the old color serving (non-fatal) when the new color never becomes ready', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.setActiveBackend.mockClear();

    h.mocks.waitColorReady.mockResolvedValueOnce(false); // the swap's green fails to serve
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('did not become ready — keeping the current proxy'),
    );
    expect(h.mocks.stopColor).toHaveBeenCalledWith('green'); // failed green torn down
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled(); // no flip
    // The loop is still running (not settled): a later SIGINT would resolve it.
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });

  it('keeps the old color serving when docker fails to bring up the new color', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.bringUpColor.mockRejectedValueOnce(new Error('docker boom'));
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('could not start the new proxy'),
    );
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });
});

describe('runProxyLoop coalescing', () => {
  it('collapses events during an in-flight swap into exactly one follow-up swap', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.bringUpColor.mockClear();

    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    h.fireAllowlist(); // swap 1 begins; its bring-up is blocked
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

    h.fireAllowlist(); // two more edits land mid-swap
    h.fireAllowlist();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // nothing new while in flight

    release();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // exactly one follow-up
  });

  it('clears unique tracking when both sources changed during an in-flight swap', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // tracked
    h.mocks.bringUpColor.mockClear();

    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

    // BOTH change while the first swap is in flight.
    h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
    h.fireCredentials();
    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nboth.example.com:443',
    );
    h.fireAllowlist();
    await flush();

    release();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // one follow-up for both

    // The follow-up included the allowlist change, so unique was cleared.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });
});

describe('runProxyLoop refresh nudging', () => {
  it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush();

    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('token did not refresh after 3 attempts'),
    );
  });

  it('resets the failure counter when a refresh succeeds mid-sequence', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush();
    await vi.advanceTimersByTimeAsync(2 * MIN);

    h.creds.value = { accessToken: 'A', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    await vi.advanceTimersByTimeAsync(60 * MIN);
    await Promise.resolve();

    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe('runProxyLoop shutdown', () => {
  it('SIGINT tears everything down once and exits 0; a second SIGINT is a no-op', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();
    h.mocks.bringUpColor.mockClear();

    h.fireSigint();
    h.fireSigint();
    await flush();

    await expect(exit).resolves.toBe(0);
    const sigintLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGINT'));
    expect(sigintLogs).toHaveLength(1);
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(2);
    expect(h.mocks.stopLogStream).toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors from `runProxyLoop.ts` (the command wiring in Task 6 will still show errors for the old deps — that is expected until Task 6; if so, proceed and let Task 6 resolve them). To keep this task self-contained, verify at minimum that `src/runProxy/runProxyLoop.ts` itself has no type errors by scanning the `tsc` output for that path.

- [ ] **Step 8: Commit**

```bash
git add src/runProxy/runProxyLoop.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat(run-proxy): blue-green swap orchestration with ready-gate, flip, drain, keep-old"
```

---

## Task 6: Command wiring + container ops + forwarder cleanup

**Files:**
- Create: `src/runProxy/colorContainer.ts`
- Modify: `src/commands/runProxy.ts`
- Modify: `src/runProxy/forwarder.ts` (remove `startForwarder`/`planForwarder`/`ForwarderPlan`/`ForwardRule`/`ForwarderOptions`/`ForwarderHandle`/`ForwarderPlanInput`; keep `resolveForwardListenAddress` + `DEFAULT_VMNET_ADAPTER`)
- Modify: `tests/unit/runProxy/forwarder.test.ts` (remove the `startForwarder` describe block)
- Modify: `templates/proxy/verify-proxy.ps1:73-78`

**Interfaces:**
- Consumes: `startGateway` (Task 4), `allocateColorPorts` (Task 2), `waitColorReady` (Task 3), the new `RunProxyDeps` (Task 5), `Color`/`ColorPorts` (Task 2).
- Produces: `bringUpColor(color: Color, ports: ColorPorts, composeDir: string): Promise<void>` and `stopColor(color: Color, composeDir: string): Promise<void>` in `colorContainer.ts`.

- [ ] **Step 1: Implement the container ops**

Create `src/runProxy/colorContainer.ts`:

```typescript
import { execa } from 'execa';
import type { Color, ColorPorts } from './types';

/**
 * Force-recreate one color's Envoy container, published on the given host ports.
 * The per-color env vars feed the compose template's `${ENVOY_<COLOR>_*}` port
 * mappings; process.env is inherited so unrelated overrides still flow through.
 * Runs in composeDir (the environment's .configamatron/proxy folder).
 */
export async function bringUpColor(
  color: Color,
  ports: ColorPorts,
  composeDir: string,
): Promise<void> {
  const prefix = `ENVOY_${color.toUpperCase()}`;
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', `envoy_${color}`], {
    cwd: composeDir,
    env: {
      ...process.env,
      [`${prefix}_HTTPS_PORT`]: String(ports.httpsPort),
      [`${prefix}_HTTP_PORT`]: String(ports.httpPort),
      [`${prefix}_ADMIN_PORT`]: String(ports.adminPort),
    },
  });
}

/** Stop one color's container (leaves it defined; a later bring-up recreates it). */
export async function stopColor(color: Color, composeDir: string): Promise<void> {
  await execa('docker', ['compose', 'stop', `envoy_${color}`], { cwd: composeDir });
}
```

- [ ] **Step 2: Trim `forwarder.ts` to just the address resolver**

In `src/runProxy/forwarder.ts`, delete everything except the `resolveForwardListenAddress` function and its `DEFAULT_VMNET_ADAPTER` constant and imports (`networkInterfaces`, `NetworkInterfaceInfo`). Remove the `import net from 'node:net'` and all of `ForwardRule`, `ForwarderOptions`, `ForwarderHandle`, `closeServer`, `startForwarder`, `ForwarderPlanInput`, `ForwarderPlan`, and `planForwarder`. The file should end after `resolveForwardListenAddress` returns.

- [ ] **Step 3: Remove the dead `startForwarder` tests**

In `tests/unit/runProxy/forwarder.test.ts`, delete from line 54 (`import net from 'node:net';`) through the end of the file (the `freePort`, `startEcho`, `roundTrip` helpers and the entire `describe('startForwarder', ...)` block). Keep only the `resolveForwardListenAddress` import and its describe block at the top.

- [ ] **Step 4: Rewire the command**

In `src/commands/runProxy.ts`:

Replace the forwarder imports (lines 16-21) with:

```typescript
import { resolveForwardListenAddress } from '../runProxy/forwarder';
import { startGateway, type GatewayHandle } from '../runProxy/gateway';
import { allocateColorPorts } from '../runProxy/allocateColorPorts';
import { bringUpColor, stopColor } from '../runProxy/colorContainer';
import { waitColorReady } from '../runProxy/waitColorReady';
import type { Color, ColorPorts } from '../runProxy/types';
```

Remove the `.option('--service <name>', ...)` line (line 61) and the `service: string;` field from `RunProxyOptions` (line 26).

Replace the log-stream deps (lines 118-125) and the `recreateContainer` dep (line 115) so the deps object provides the new container/gateway deps. The gateway is created before `runProxyLoop`, so declare it in an outer scope. Restructure the action body so that, after computing `httpPort`/`httpsPort` (lines 132-134) and resolving listen addresses, you build the gateway, then build deps referencing it. Concretely:

Replace the block from `let logHandle` (line 95) through the end of the `deps` object (line 130) with:

```typescript
      let logHandle: LogStreamHandle | null = null;

      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];

      // The gateway always owns the public ports on loopback; when forwarding is
      // enabled it also listens on the VMware host-only adapter. Both point at the
      // active color's backend ports.
      const listenAddresses = ['127.0.0.1'];
      if (options.forward) {
        const vmnet = options.forwardListen ?? resolveForwardListenAddress();
        if (!vmnet) {
          console.error(
            'run-proxy: could not find the VMware host-only adapter IP to forward from. ' +
              'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
          );
          process.exitCode = 1;
          return;
        }
        listenAddresses.push(vmnet);
      }

      let gateway: GatewayHandle;
      try {
        gateway = await startGateway({
          listenAddresses,
          httpsListenPort: httpsPort,
          httpListenPort: httpPort,
        });
      } catch (err) {
        console.error(`run-proxy: failed to start the gateway forwarder: ${String(err)}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `run-proxy: gateway listening on ${listenAddresses.join(', ')} :${httpPort}/${httpsPort}`,
      );

      const deps: RunProxyDeps = {
        readCredentials,
        readAllowlist: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return null;
          }
        },
        writeSecret,
        buildConfig: (allowlist) =>
          writeEnvoyConfig(allowlist, paths.envoyConfig, options.upstreamOverride),
        ensureLeaf: (sans) =>
          ensureLeaf(
            paths,
            readFileSync(paths.caCert, 'utf8'),
            readFileSync(paths.caKey, 'utf8'),
            sans,
          ),
        allocatePorts: allocateColorPorts,
        bringUpColor: (color: Color, ports: ColorPorts) => bringUpColor(color, ports, paths.proxy),
        waitColorReady: (ports: ColorPorts, timeoutMs: number) =>
          waitColorReady(ports.adminPort, timeoutMs),
        setActiveBackend: (ports: ColorPorts) =>
          gateway.setTarget({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }),
        drainBackend: (ports: ColorPorts, timeoutMs: number) =>
          gateway.drain({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }, timeoutMs),
        stopColor: (color: Color) => stopColor(color, paths.proxy),
        nudgeRefresh,
        watch: watchFile,
        startLogStream: (color: Color, onLine) => {
          logHandle = startLogStream(`envoy_${color}`, paths.proxy, onLine);
        },
        stopLogStream: async () => {
          const handle = logHandle;
          logHandle = null;
          await handle?.stop();
        },
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };
```

Then delete the now-obsolete forwarder block (old lines 136-167: the `let forwarder`, `planForwarder`, and `plan.kind` handling).

Update the `runProxyLoop` config object (old lines 171-181): remove `serviceName: options.service`, and add the two timeouts:

```typescript
          {
            credentialsPath: options.credentials,
            allowlistPath: paths.allowlist,
            secretPath,
            readyTimeoutMs: 60_000,
            drainTimeoutMs: 30_000,
            refreshWindowMs: Number(options.refreshWindow) * 60_000,
            retryIntervalMs: Number(options.retryInterval) * 60_000,
            maxAttempts: Number(options.maxAttempts),
            refreshEnabled: options.refresh,
          },
```

Finally, update the `finally` block (old lines 184-186) to close the gateway:

```typescript
      } finally {
        await gateway.close();
      }
```

- [ ] **Step 5: Fix the verify script's container check**

In `templates/proxy/verify-proxy.ps1`, replace the `$envoy = & docker ps ...` block (lines 73-78) with a check that matches either color:

```powershell
$envoy = & docker ps `
    --filter 'label=com.docker.compose.project=configamatron' `
    --format '{{.Names}} {{.Status}}' 2>$null | Where-Object { $_ -match 'envoy' }
if ($envoy -match 'Up') { Add-Pass "envoy container running ($(($envoy | Select-Object -First 1).Trim()))" }
else { Add-Fail 'envoy container running' "no running configamatron envoy container ('$envoy') -- run 'configamatron run-proxy'" }
```

- [ ] **Step 6: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass; `dist/cli.js` rebuilt.

- [ ] **Step 7: Run the full unit + forwarder suite**

Run: `pnpm test:unit`
Expected: PASS (runProxyLoop, gateway, allocateColorPorts, waitColorReady, forwarder-resolver, templates).

- [ ] **Step 8: Commit**

```bash
git add src/runProxy/colorContainer.ts src/commands/runProxy.ts src/runProxy/forwarder.ts tests/unit/runProxy/forwarder.test.ts templates/proxy/verify-proxy.ps1
git commit -m "feat(run-proxy): wire gateway + blue-green container ops; retire single-container forwarder"
```

---

## Task 7: Integration test — swap + color alternation

**Files:**
- Modify: `tests/integration/runProxy.test.ts`

**Interfaces:**
- Consumes: run-proxy stdout vocabulary (Global Constraints) and the on-disk secret file.

- [ ] **Step 1: Rewrite the integration test to gate on stdout + secret file**

Overwrite `tests/integration/runProxy.test.ts` with:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

const HTTPS_PORT = 18543;
const HTTP_PORT = 18180;

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
};

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

async function waitForLine(needle: string, timeoutMs: number, fromIndex = 0): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = fromIndex; i < stdoutLines.length; i++) {
      if (stdoutLines[i].includes(needle)) return i;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-proxy output containing '${needle}'\n` +
          `--- run-proxy output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-int-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-initial');

  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token (blue)', 60000);
}, 120000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore non-zero/kill result
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('run-proxy applies credential rotations with a blue-green swap', () => {
  it('swaps blue->green->blue across rotations and serves the new token each time', async () => {
    const mark1 = stdoutLines.length;
    writeCredentials('token-rotated');
    await waitForLine('swap complete — now serving green', 90000, mark1);
    expect(readFileSync(join(proxyDir, 'secrets', 'sds-secret.yaml'), 'utf8')).toContain(
      'Bearer token-rotated',
    );

    const mark2 = stdoutLines.length;
    writeCredentials('token-again');
    await waitForLine('swap complete — now serving blue', 90000, mark2);
    expect(readFileSync(join(proxyDir, 'secrets', 'sds-secret.yaml'), 'utf8')).toContain(
      'Bearer token-again',
    );
  }, 200000);
});
```

- [ ] **Step 2: Build and run the integration test**

Run: `pnpm build && pnpm test:integration`
Expected: PASS — two real container swaps observed, secret file updated each time. (Requires Docker running.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/runProxy.test.ts
git commit -m "test(integration): assert blue-green swap + color alternation on credential rotation"
```

---

## Task 8: VM e2e harness — gate on stdout, drop admin/container-id helpers

**Files:**
- Modify: `tests/proxyStack.ts`
- Modify: `tests/vm/vm.test.ts`

**Interfaces:**
- Consumes: the `swap complete` and `serving the current token` stdout lines.

- [ ] **Step 1: Rework `proxyStack.ts` startup gate and drop dead helpers**

In `tests/proxyStack.ts`:

Remove `ADMIN_PORT` from the exported constants (line 12) and from `composeEnv` (line 155). Delete `adminReadyOnce` (lines 39-55), `waitForAdminReady` (lines 57-64), `getEnvoyContainerId` (lines 66-74), and `waitForEnvoyRestart` (lines 85-103). Remove the now-unused `httpRequest` import (line 3).

Add a module-level line-wait helper (place it near `waitForProxyLine`):

```typescript
async function waitForStartupLine(
  lines: string[],
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some((l) => l.includes(needle))) return;
    await sleep(250);
  }
  throw new Error(
    `run-proxy never logged '${needle}'\n--- run-proxy output ---\n${lines.join('\n')}`,
  );
}
```

In `startProxyStack`, replace `await waitForAdminReady(60000);` (line 199) with:

```typescript
  await waitForStartupLine(stdoutLines, 'serving the current token', 60000);
```

- [ ] **Step 2: Point the VM restart tests at `swap complete`**

In `tests/vm/vm.test.ts`:

Remove `getEnvoyContainerId` and `waitForEnvoyRestart` from the import (lines 9-10).

In the allowlist-restart test, replace lines 311-320 (the `const oldId = ...` capture and the two `waitForProxyLine`/`waitForEnvoyRestart` calls) with:

```typescript
    const mark = stack.stdoutLines.length;

    // The staged fixture ends with the '# terminate' section, so appending
    // adds a terminate host — the terminate-host set changes and the
    // leaf-reissue path runs too, not just the config rebuild.
    appendFileSync(stack.allowlistPath, 'example.org:443\n');

    await waitForProxyLine(stack, 'restarting proxy — allowlist changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);
```

In the credential-rotation test, replace lines 334-339 (the `oldId` capture and the two wait calls) with:

```typescript
    const mark = stack.stdoutLines.length;
    writeStackCredentials(stack, 'rotated-vm-test-token');

    await waitForProxyLine(stack, 'restarting proxy — credentials changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (no remaining references to the deleted helpers or `ADMIN_PORT`).

- [ ] **Step 4: Run the VM suite**

Run: `pnpm test:vm`
Expected: PASS (23/23). The passthrough probe fired right after a swap must succeed, because `swap complete` is logged only after the new color is ready and flipped and the old color has drained. First run builds the golden image (~10-20 min); subsequent runs ~2 min.

- [ ] **Step 5: Commit**

```bash
git add tests/proxyStack.ts tests/vm/vm.test.ts
git commit -m "test(vm): gate restarts on run-proxy 'swap complete'; drop admin/container-id helpers"
```

---

## Self-Review

**Spec coverage:**
- Two-container compose topology → Task 1. ✅
- Dynamic port allocation → Task 2 (`allocateColorPorts`) + Task 6 (env wiring). ✅
- Gateway forwarder (always-on loopback + VMnet, mutable target, connection tracking, drain) → Task 4 (gateway) + Task 6 (listenAddresses). ✅
- Swap sequence (bring up idle → ready-gate → flip → drain → stop → re-point log stream) → Task 5. ✅
- Startup ready-gate → Task 5 (start() rewrite). ✅
- Readiness ownership / stdout gating → Task 5 log lines + Tasks 7, 8. ✅
- Green-fails-to-ready → keep old + log (non-fatal) → Task 5 (both bring-up-fail and not-ready tests). ✅
- Drain timeout default 30s, configurable → Task 5 config `drainTimeoutMs`, Task 6 sets 30_000. ✅
- Two compose services (not raw docker run) → Task 1 + Task 6 `colorContainer`. ✅
- `envoyConfig.ts` untouched → not in any task's file list. ✅
- Existing-connection-survives-swap guarantee → Task 4 gateway test (spec §Testing; implemented at the gateway layer where the behavior lives, rather than integration, for determinism). ✅
- verify-proxy.ps1 still valid → Task 6 Step 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the exact run command with expected result. ✅

**Type consistency:** `Color`/`ColorPorts`/`otherColor` (Task 2) are used identically in `runProxyLoop.ts` (Task 5), `colorContainer.ts` and the command (Task 6). Dep names (`allocatePorts`, `bringUpColor`, `waitColorReady`, `setActiveBackend`, `drainBackend`, `stopColor`, `startLogStream(color, onLine)`) match between the interface (Task 5 Step 1), the test harness (Task 5 Step 5), and the command wiring (Task 6 Step 4). `GatewayTarget`/`GatewayHandle` (Task 4) match their use in the command's `setActiveBackend`/`drainBackend`. `RunProxyConfig` loses `serviceName` and gains `readyTimeoutMs`/`drainTimeoutMs` consistently in Task 5 and Task 6. ✅

**Note for the implementer:** Tasks 1–4 are independent and can be done in any order; Task 5 depends on Task 2; Task 6 depends on Tasks 2–5; Tasks 7 and 8 depend on Task 6 and require Docker (and, for Task 8, the VM harness).
```
