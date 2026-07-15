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
  'vm-shared/configamatron-egress.service',
  'vm-shared/verify-config.sh',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/host-allow-vm-inbound.ps1',
  'proxy/verify-proxy.ps1',
  'vm-shared-windows/01-install-packages.ps1',
  'vm-shared-windows/02-install-pnpm.ps1',
  'vm-shared-windows/03-install-tools.ps1',
  'vm-shared-windows/04-configure-tools.ps1',
  'vm-shared-windows/05-github-auth.ps1',
  'vm-shared-windows/06-trust-ca.ps1',
  'vm-shared-windows/08-claude-config.ps1',
  'vm-shared-windows/07-setup-network.ps1',
  'vm-shared-windows/dns-responder/ConfigamatronDnsResponder.csproj',
  'vm-shared-windows/dns-responder/Program.cs',
  'vm-shared-windows/verify-config.ps1',
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
    const netplan = readFileSync(join(templatesDir(), 'vm-shared', '60-dns-override.yaml'), 'utf8');
    // networkd honors use-dns; NetworkManager needs the keyfile passthrough.
    // Without both, VMware's host-only DHCP adds the (dead) VMnet host IP as a
    // second resolver and lookups stall intermittently.
    expect(netplan).toContain('use-dns: false');
    expect(netplan).toContain('ipv4.ignore-auto-dns: "true"');
  });

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

  it('windows 05-github-auth parses the double-quoted github-config format', () => {
    const script = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '05-github-auth.ps1'),
      'utf8',
    );
    // The config file is GITHUB_USERNAME="..." etc; the parser must strip quotes.
    expect(script).toContain('GITHUB_USERNAME');
    expect(script).toContain("Trim('\"')");
  });

  it('windows CA + claude scripts cover all trust surfaces and the placeholder', () => {
    const ca = readFileSync(join(templatesDir(), 'vm-shared-windows', '06-trust-ca.ps1'), 'utf8');
    expect(ca).toContain('certutil'); // Windows machine Root store
    expect(ca).toContain('NODE_EXTRA_CA_CERTS'); // Node tools
    expect(ca).toContain('http.sslBackend schannel'); // git

    const claude = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '08-claude-config.ps1'),
      'utf8',
    );
    expect(claude).toContain('hasCompletedOnboarding');
    expect(claude).toContain('.credentials.json');
  });

  it('windows DNS redirect wires responder to the host IP and adapter DNS', () => {
    const net = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '07-setup-network.ps1'),
      'utf8',
    );
    expect(net).toContain('Register-ScheduledTask');
    expect(net).toContain('ConfigamatronDnsResponder');
    expect(net).toContain('responder-config.txt'); // host IP written for the responder
    expect(net).toContain('Set-DnsClientServerAddress');
    expect(net).toContain("'127.0.0.1'");

    // The responder is built from a writable scratch dir, not published directly from
    // the read-only share (which cannot hold dotnet's obj/ intermediates).
    expect(net).toContain('dns-responder-build');
    expect(net).toContain('Copy-Item');

    const prog = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'dns-responder', 'Program.cs'),
      'utf8',
    );
    expect(prog).toContain('responder-config.txt'); // reads the target IP
    expect(prog).toContain('53'); // binds DNS port
  });

  it('windows verify-config checks the placeholder invariant and gate', () => {
    const v = readFileSync(join(templatesDir(), 'vm-shared-windows', 'verify-config.ps1'), 'utf8');
    expect(v).toContain('sk-ant-oat-SANDBOX-PLACEHOLDER'); // no real token may live in the guest
    expect(v).toContain('api.anthropic.com'); // credential-gate check
    expect(v).toContain('curl.exe'); // live egress via bundled curl
  });

  it('ubuntu 01-apt-packages installs jq for JSON edits', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '01-apt-packages.sh'), 'utf8');
    expect(s).toContain('jq');
  });

  it('ubuntu 08-claude-config writes .claude.json with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '08-claude-config.sh'), 'utf8');
    expect(s).toContain('jq . "$claude_json"');
    expect(s).toContain('.hasCompletedOnboarding = true');
    expect(s).not.toContain('python3');
  });

  it('ubuntu 04-configure-tools writes settings.json with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '04-configure-tools.sh'), 'utf8');
    expect(s).toContain('jq . "$vscode_settings"');
    expect(s).toContain('.["editor.defaultFormatter"] = "esbenp.prettier-vscode"');
    expect(s).not.toContain('python3');
  });

  it('ubuntu 06-trust-ca merges the Firefox CA with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '06-trust-ca.sh'), 'utf8');
    expect(s).toContain('sudo jq . "$policy_file"');
    expect(s).toContain('.policies.Certificates.Install');
    expect(s).not.toContain('python3');
  });

  it('windows 08-claude-config writes .claude.json with jq', () => {
    const s = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '08-claude-config.ps1'),
      'utf8',
    );
    expect(s).toContain('jq . $claudeJson');
    expect(s).toContain('.hasCompletedOnboarding = true');
    expect(s).not.toContain('ConvertTo-Json');
  });

  it('windows 04-configure-tools writes settings.json with jq', () => {
    const s = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '04-configure-tools.ps1'),
      'utf8',
    );
    expect(s).toContain('jq . $vscodeSettings');
    expect(s).not.toContain('ConvertTo-Json');
  });
});
