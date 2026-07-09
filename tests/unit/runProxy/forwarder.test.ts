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
    expect(
      resolveForwardListenAddress(DEFAULT_VMNET_ADAPTER, { 'Wi-Fi': [ipv4('10.0.0.5')] }),
    ).toBeNull();
  });

  it('skips internal and IPv6 addresses', () => {
    const interfaces = {
      'VMware Network Adapter VMnet1': [
        { ...ipv4('127.0.0.1', true) },
        {
          address: 'fe80::1',
          netmask: 'ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        } as NetworkInterfaceInfo,
        ipv4('192.168.241.1'),
      ],
    };
    expect(resolveForwardListenAddress(DEFAULT_VMNET_ADAPTER, interfaces)).toBe('192.168.241.1');
  });
});

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
