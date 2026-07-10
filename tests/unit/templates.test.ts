import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagedAllowlist, templatesDir } from '../../src/templates';

const expectedTemplateFiles = [
  'vm-shared/01-apt-packages.sh',
  'vm-shared/02-install-pnpm.sh',
  'vm-shared/03-install-tools.sh',
  'vm-shared/04-configure-tools.sh',
  'vm-shared/05-github-auth.sh',
  'vm-shared/06-trust-ca.sh',
  'vm-shared/07-setup-persistence.sh',
  'vm-shared/08-claude-config.sh',
  'vm-shared/dnsmasq-stub.conf',
  'vm-shared/60-dns-override.yaml',
  'vm-shared/iptables-rules@.service',
  'vm-shared/verify-config.sh',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/host-allow-vm-inbound.ps1',
  'proxy/verify-proxy.ps1',
];

describe('templates', () => {
  it('ships every template file', () => {
    for (const file of expectedTemplateFiles) {
      expect(existsSync(join(templatesDir(), file)), file).toBe(true);
    }
  });

  it('ships the packaged allowlist', () => {
    expect(existsSync(packagedAllowlist())).toBe(true);
  });

  it('pins the compose project name so environments replace each other', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('name: configamatron');
  });

  it('suppresses DHCP-supplied DNS on both renderers so the stub is the only resolver', () => {
    const netplan = readFileSync(
      join(templatesDir(), 'vm-shared', '60-dns-override.yaml'),
      'utf8',
    );
    // networkd honors use-dns; NetworkManager needs the keyfile passthrough.
    // Without both, VMware's host-only DHCP adds the (dead) VMnet host IP as a
    // second resolver and lookups stall intermittently.
    expect(netplan).toContain('use-dns: false');
    expect(netplan).toContain('ipv4.ignore-auto-dns: "true"');
  });

  it('publishes Envoy on loopback only so the run-proxy forwarder owns the host-only interface', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('127.0.0.1:${ENVOY_HTTPS_PORT:-443}:443');
    expect(compose).toContain('127.0.0.1:${ENVOY_HTTP_PORT:-80}:80');
    expect(compose).toContain('127.0.0.1:${ENVOY_ADMIN_PORT:-9901}:9901');
  });
});
