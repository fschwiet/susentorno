import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostMcpServerDestination } from '../../src/envoyConfig';
import { parseAllowlist, leafSanHosts } from '../../src/allowlist';
import { writeEnvoyConfig } from '../../src/runProxy/buildConfig';
import { ensureLeaf } from '../../src/leaf';
import { envPaths, type EnvPaths } from '../../src/envPaths';
import { allocateColorPorts } from '../../src/runProxy/allocateColorPorts';
import { bringUpColor } from '../../src/runProxy/colorContainer';
import { waitColorReady } from '../../src/runProxy/waitColorReady';
import { isColorRunning } from '../../src/runProxy/isColorRunning';
import { parseLine } from '../../src/runProxy/parseLine';
import { classify } from '../../src/runProxy/classify';
import { formatOutput } from '../../src/runProxy/formatOutput';
import type { ColorPorts } from '../../src/runProxy/types';
import { rmEnvRoot } from '../rmEnvRoot';
import { repoRoot, envParent, envRoot } from '../testEnvRoot';

// This suite builds envoy.yaml directly (via generateEnvoyConfig with a Host MCP
// server destination) and brings Envoy up with docker compose directly, the same
// way run-proxy itself would at startup — but without run-proxy's process
// supervision (issue #60), since the loopback HTTP server standing in for the MCP
// server is already running before the stack comes up. See
// docs/adr/0016-host-run-mcp-servers.md.

const MCP_HOST = 'fake-mcp.internal';
const cliPath = join(repoRoot, 'dist', 'cli.js');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const authFixture = join(repoRoot, 'tests', 'fixtures', 'auth.json');

interface McpUpstream {
  server: Server;
  port: number;
  receivedHeaders: IncomingHttpHeaders[];
}

function startMcpUpstream(): Promise<McpUpstream> {
  const receivedHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    receivedHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mcp-upstream-ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind the loopback MCP upstream');
      }
      resolve({ server, port: address.port, receivedHeaders });
    });
  });
}

function stopMcpUpstream(mock: McpUpstream): Promise<void> {
  return new Promise((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}

let mcpUpstream: McpUpstream;
let paths: EnvPaths;
let caCertPem: string;
let ports: ColorPorts;

beforeAll(async () => {
  mcpUpstream = await startMcpUpstream();

  // Fresh environment per run, same as tests/proxyStack.ts's startProxyStack.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );
  paths = envPaths(envParent);

  // A minimal allowlist: one passthrough entry (so the passthrough filter chain's
  // SNI match list is non-empty) and nothing else — this suite is only about the
  // Host MCP server destination, not credential injection or passthrough routing.
  writeFileSync(paths.allowlist, '#pragma passthrough\nnever-contacted.example.internal:443\n');

  // generate-ca derives leaf SANs from the allowlist alone, so it does not know
  // about the MCP host and skips issuing a leaf (no TLS-terminated allowlist
  // entries). Reissue the leaf ourselves with the MCP host folded in, exactly as
  // run-proxy's own startup does via leafSanHosts(allowlist, mcpHosts).
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });
  const allowlist = parseAllowlist(readFileSync(paths.allowlist, 'utf8'));
  const caCertPemLocal = readFileSync(paths.caCert, 'utf8');
  const caKeyPemLocal = readFileSync(paths.caKey, 'utf8');
  ensureLeaf(paths, caCertPemLocal, caKeyPemLocal, leafSanHosts(allowlist, [MCP_HOST]));
  caCertPem = caCertPemLocal;

  const mcpServers: HostMcpServerDestination[] = [{ host: MCP_HOST, port: mcpUpstream.port }];
  writeEnvoyConfig(allowlist, paths.envoyConfig, [], undefined, mcpServers);

  ports = await allocateColorPorts();
  await bringUpColor('blue', ports, paths.proxy);
  const result = await waitColorReady(ports.adminPort, 60000, new AbortController().signal, () =>
    isColorRunning('blue', paths.proxy),
  );
  if (!result.ready) {
    throw new Error(`envoy_blue never became ready (${result.reason})`);
  }
}, 90000);

afterAll(async () => {
  await execa('docker', ['compose', 'down'], { cwd: paths.proxy, reject: false });
  await stopMcpUpstream(mcpUpstream);
}, 30000);

function requestThroughMcpHost(
  authorization: string | undefined,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: ports.httpsPort,
        servername: MCP_HOST,
        ca: caCertPem,
        path: '/',
        headers: { ...(authorization ? { authorization } : {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Host MCP server reachability', () => {
  it('matches the server hostname by SNI and terminates TLS with a leaf that chains to the trusted root CA', async () => {
    const peer = await new Promise<{ subjectCN?: string; issuerCN?: string }>((resolve, reject) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: ports.httpsPort, servername: MCP_HOST, ca: caCertPem },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          const cn = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
          resolve({ subjectCN: cn(cert.subject?.CN), issuerCN: cn(cert.issuer?.CN) });
        },
      );
      socket.on('error', reject);
    });

    // Handshake succeeded with `ca: caCertPem` (rejectUnauthorized defaults true), so the
    // leaf already chains to the installed root CA — confirm it is a distinct leaf.
    expect(peer.subjectCN).toBe('configamatron-proxy-leaf');
    expect(peer.issuerCN).toBe('configamatron-proxy-certificate-authority');
  });

  it('forwards cleartext to the loopback upstream with no upstream TLS and no credential injection', async () => {
    const before = mcpUpstream.receivedHeaders.length;
    const { statusCode, body } = await requestThroughMcpHost('Bearer guest-supplied-token');

    // Succeeding at all proves the hop to the upstream is plain HTTP: the loopback
    // upstream never speaks TLS, so a TLS-wrapped forward would fail the handshake.
    expect(statusCode).toBe(200);
    expect(body).toBe('mcp-upstream-ok');

    const received = mcpUpstream.receivedHeaders.slice(before);
    expect(received).toHaveLength(1);
    // No credential_injector on this chain: the client's own header passes through
    // unmodified rather than being replaced or stripped.
    expect(received[0].authorization).toBe('Bearer guest-supplied-token');

    // And the converse: a client that sends no Authorization header at all still
    // reaches the upstream with none. This rules out a credential_injector configured
    // overwrite:false, which only fires when the header is absent — the present-header
    // case above would look identical whether or not one were wired in.
    const beforeAbsent = mcpUpstream.receivedHeaders.length;
    const absent = await requestThroughMcpHost(undefined);
    expect(absent.statusCode).toBe(200);
    const receivedAbsent = mcpUpstream.receivedHeaders.slice(beforeAbsent);
    expect(receivedAbsent).toHaveLength(1);
    expect(receivedAbsent[0].authorization).toBeUndefined();
  });

  async function readEnvoyLogs(): Promise<string> {
    const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy_blue'], {
      cwd: paths.proxy,
    });
    return stdout;
  }

  it('shows the ALLOW MCP classification for the connection', async () => {
    // Only lines appended after this baseline can belong to the request this test
    // is about to make — earlier tests in this file also hit the MCP host.
    const baselineLineCount = (await readEnvoyLogs()).split('\n').length;
    await requestThroughMcpHost(undefined);

    const deadline = Date.now() + 10000;
    let mcpLine: string | undefined;
    while (Date.now() < deadline && !mcpLine) {
      const newLines = (await readEnvoyLogs()).split('\n').slice(baselineLineCount);
      mcpLine = newLines.find((l) => l.includes('CFGM|mcp|') && l.includes(MCP_HOST));
      if (!mcpLine) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(mcpLine, 'expected a new CFGM|mcp| access-log line for the MCP host').toBeDefined();

    const parsed = parseLine(mcpLine!.slice(mcpLine!.indexOf('CFGM|')));
    expect(parsed).not.toBeNull();
    const entries = classify(parsed!);
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe('ALLOW MCP');
    expect(entries[0].domain).toBe(MCP_HOST);
    expect(formatOutput(entries[0])).toContain(`ALLOW MCP  ${MCP_HOST}`);
  }, 30000);
});
