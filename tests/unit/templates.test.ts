import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagedAllowlist, templatesDir } from '../../src/templates';
import { parseAllowlist } from '../../src/allowlist';
import { NO_AUTH_MARKER_HEADER, NO_AUTH_SENTINEL_VALUE } from '../../src/envoyConfig';

const expectedTemplateFiles = [
  'vm-shared/pre-scripts/01-apt-packages.sh',
  'vm-shared/pre-scripts/02-install-pnpm.sh',
  'vm-shared/pre-scripts/03-install-tools.sh',
  'vm-shared/pre-scripts/04-configure-tools.sh',
  'vm-shared/pre-scripts/nn-configure-network.sh',
  'vm-shared/post-scripts/01-auth-config.sh',
  'vm-shared/post-scripts/02-apply-home-jq-transforms.sh',
  'vm-shared/verify-config.sh',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/host-allow-vm-inbound.ps1',
  'proxy/verify-proxy.ps1',
  'vm-shared-windows/pre-scripts/01-install-packages.ps1',
  'vm-shared-windows/pre-scripts/02-install-pnpm.ps1',
  'vm-shared-windows/pre-scripts/03-install-tools.ps1',
  'vm-shared-windows/pre-scripts/04-configure-tools.ps1',
  'vm-shared-windows/pre-scripts/nn-configure-network.ps1',
  'vm-shared-windows/post-scripts/01-auth-config.ps1',
  'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
  'vm-shared-windows/verify-config.ps1',
  'home-jq-transforms/manifest.yaml',
  'home-jq-transforms/vscode-settings.jq',
  'home-jq-transforms/claude-onboarding.jq',
  'configamatron.gitignore',
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

  it('ships chatgpt.com under codex authenticated, not passthrough', () => {
    const parsed = parseAllowlist(readFileSync(packagedAllowlist(), 'utf8'));
    expect(parsed.codexAuthenticated).toContain('chatgpt.com:443');
    expect(parsed.passthrough).not.toContain('chatgpt.com:443');
    expect(parsed.passthrough).toContain('*.chatgpt.com:443');
  });

  it('gate.lua uses the same no-auth marker/sentinel literals as envoyConfig.ts and no longer rejects', () => {
    const gate = readFileSync(join(templatesDir(), 'proxy', 'gate.lua'), 'utf8');
    expect(gate).toContain(`"${NO_AUTH_MARKER_HEADER}"`);
    expect(gate).toContain(`"${NO_AUTH_SENTINEL_VALUE}"`);
    expect(gate).not.toContain('403');
    expect(gate).not.toContain('unexpected credential');
  });

  it('pins the compose project name so environments replace each other', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('name: configamatron');
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

  it('windows 06-auth-config parses the double-quoted github-config format', () => {
    const script = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
      'utf8',
    );
    expect(script).toContain('GITHUB_USERNAME');
    expect(script).toContain("Trim('\"')");
  });

  it('windows 06-auth-config fails loudly when gh auth login or setup-git fails', () => {
    const script = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
      'utf8',
    );
    expect(script).toMatch(/gh auth login --with-token\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
    expect(script).toMatch(/gh auth setup-git\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  });

  it('windows 05-configure-network covers CA trust surfaces; 06-auth-config installs the placeholder', () => {
    const net = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'pre-scripts', 'nn-configure-network.ps1'),
      'utf8',
    );
    expect(net).toContain('certutil');
    expect(net).toContain('NODE_EXTRA_CA_CERTS');
    expect(net).toContain('http.sslBackend schannel');
    const auth = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
      'utf8',
    );
    expect(auth).toContain('.credentials.json');
  });

  it('windows verify-config checks the placeholder invariant and gate', () => {
    const v = readFileSync(join(templatesDir(), 'vm-shared-windows', 'verify-config.ps1'), 'utf8');
    expect(v).toContain('sk-ant-oat-SANDBOX-PLACEHOLDER'); // no real token may live in the guest
    expect(v).toContain('api.anthropic.com'); // credential-gate check
    expect(v).toContain('curl.exe'); // live egress via bundled curl
  });

  it('ubuntu 01-apt-packages installs jq and gh', () => {
    const s = readFileSync(
      join(templatesDir(), 'vm-shared', 'pre-scripts', '01-apt-packages.sh'),
      'utf8',
    );
    expect(s).toMatch(/apt install -y .*\bjq\b/);
    expect(s).toMatch(/apt install -y .*\bgh\b/);
  });

  it('ubuntu 05-configure-network leaves addressing and DNS to DHCP', () => {
    const s = readFileSync(
      join(templatesDir(), 'vm-shared', 'pre-scripts', 'nn-configure-network.sh'),
      'utf8',
    );
    expect(s).toContain('come from the host via DHCP');
    expect(s).not.toContain('python3');
  });

  it('seed transforms reproduce the extracted inline jq programs', () => {
    const vscode = readFileSync(
      join(templatesDir(), 'home-jq-transforms', 'vscode-settings.jq'),
      'utf8',
    );
    expect(vscode).toContain('.["editor.defaultFormatter"] = "esbenp.prettier-vscode"');
    const claude = readFileSync(
      join(templatesDir(), 'home-jq-transforms', 'claude-onboarding.jq'),
      'utf8',
    );
    expect(claude).toContain('.hasCompletedOnboarding = true');
  });

  it('host-allow-vm-inbound scopes rules by LocalAddress, splits SMB/node.exe, and drops node discovery', () => {
    const script = readFileSync(join(templatesDir(), 'proxy', 'host-allow-vm-inbound.ps1'), 'utf8');
    expect(script).not.toContain('Resolve-RunProxyNode');
    expect(script).not.toContain('-NodePath');
    expect(script).toContain('$hostIp = ');
    expect(script).toContain('$natHostIp = ');
    expect((script.match(/-LocalAddress \$hostIp/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(script).toContain('-LocalAddress $natHostIp');
    expect((script.match(/-LocalPort 445/g) ?? []).length).toBe(2);
    expect((script.match(/-Program \$nodePath/g) ?? []).length).toBe(3);
    expect(script).toContain('.configamatron-host\\run-proxy-node.exe');
  });

  it('verify-proxy checks the host network model and any stale node.exe Query User rule', () => {
    const script = readFileSync(join(templatesDir(), 'proxy', 'verify-proxy.ps1'), 'utf8');
    expect(script).toContain('Get-NetIPInterface');
    expect(script).toContain('WeakHostReceive');
    expect(script).toContain('Forwarding');
    expect(script).toContain("EndsWith('node.exe'");
  });

  it('verify-proxy validates rule filters and state, not just DisplayName presence', () => {
    const script = readFileSync(join(templatesDir(), 'proxy', 'verify-proxy.ps1'), 'utf8');
    expect(script).toContain('Get-NetFirewallAddressFilter');
    expect(script).toContain('Get-NetFirewallPortFilter');
    expect(script).toContain('Get-NetFirewallInterfaceFilter');
    expect(script).toContain('Get-NetFirewallApplicationFilter');
    expect(script).toContain('Enabled.ToString()');
    expect(script).toContain('Direction.ToString()');
    expect(script).toContain('Action.ToString()');
    expect(script).toContain('$NatAdapterAlias');
    expect(script).toContain('SkipAddress');
    expect((script.match(/Test-RuleSet -Label/g) ?? []).length).toBe(5);
  });
});
