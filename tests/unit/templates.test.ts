import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  packagedAllowList,
  packagedAuthList,
  packagedBlockList,
  templatesDir,
} from '../../src/templates';
import { loadManifest } from '../../src/homeJqTransforms';
import { parseAllowListFile, parseAuthListFile } from '../../src/allowlist';
import {
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  NO_ACCOUNT_ID_MARKER_HEADER,
} from '../../src/envoyConfig';
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from '../../src/codexPlaceholder';

const expectedTemplateFiles = [
  'vm-shared-linux/pre-scripts/01-apt-packages.sh',
  'vm-shared-linux/pre-scripts/02-install-pnpm.sh',
  'vm-shared-linux/pre-scripts/03-install-tools.sh',
  'vm-shared-linux/pre-scripts/nn-configure-network.sh',
  'vm-shared-linux/post-scripts/01-auth-config.sh',
  'vm-shared-linux/post-scripts/02-apply-home-jq-transforms.sh',
  'vm-shared-linux/verify-config.sh',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/verify-proxy.ps1',
  'vm-shared-windows/pre-scripts/01-install-packages.ps1',
  'vm-shared-windows/pre-scripts/02-install-pnpm.ps1',
  'vm-shared-windows/pre-scripts/03-install-tools.ps1',
  'vm-shared-windows/pre-scripts/nn-configure-network.ps1',
  'vm-shared-windows/post-scripts/01-auth-config.ps1',
  'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
  'vm-shared-windows/verify-config.ps1',
  'home-jq-transforms/manifest.yaml',
  'home-jq-transforms/claude-onboarding.jq',
  'susentorno.gitignore',
];

describe('generated provisioning inventory', () => {
  describe('packaged template & allowlist inventory', () => {
    it('ships every template file', () => {
      for (const file of expectedTemplateFiles) {
        expect(existsSync(join(templatesDir(), file)), file).toBe(true);
      }
    });

    it('ships exactly the four ubuntu pre-scripts a guest requires', () => {
      const dir = join(templatesDir(), 'vm-shared-linux', 'pre-scripts');
      expect(readdirSync(dir).sort()).toEqual([
        '01-apt-packages.sh',
        '02-install-pnpm.sh',
        '03-install-tools.sh',
        'nn-configure-network.sh',
      ]);
    });

    it('ships exactly the four windows pre-scripts a guest requires', () => {
      const dir = join(templatesDir(), 'vm-shared-windows', 'pre-scripts');
      expect(readdirSync(dir).sort()).toEqual([
        '01-install-packages.ps1',
        '02-install-pnpm.ps1',
        '03-install-tools.ps1',
        'nn-configure-network.ps1',
      ]);
    });

    it('windows configure-network no longer prints its own woven number', () => {
      const net = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'pre-scripts', 'nn-configure-network.ps1'),
        'utf8',
      );
      expect(net).not.toContain('05-configure-network');
      expect(net).toContain('configure-network:');
    });

    it('ships the packaged allow list, auth list, and block list', () => {
      expect(existsSync(packagedAllowList())).toBe(true);
      expect(existsSync(packagedAuthList())).toBe(true);
      expect(existsSync(packagedBlockList())).toBe(true);
    });

    it('ships chatgpt.com under codex authenticated, not the allow list', () => {
      const authList = parseAuthListFile(readFileSync(packagedAuthList(), 'utf8'));
      const allowList = parseAllowListFile(readFileSync(packagedAllowList(), 'utf8'));
      expect(authList.codexAuthenticated).toContain('chatgpt.com:443');
      expect(allowList.entries).not.toContain('chatgpt.com:443');
      expect(allowList.entries).toContain('*.chatgpt.com:443');
    });
  });

  describe('proxy container templates', () => {
    it('gate.lua uses the same no-auth marker/sentinel literals as envoyConfig.ts and no longer rejects', () => {
      const gate = readFileSync(join(templatesDir(), 'proxy', 'gate.lua'), 'utf8');
      expect(gate).toContain(`"${NO_AUTH_MARKER_HEADER}"`);
      expect(gate).toContain(`"${NO_AUTH_SENTINEL_VALUE}"`);
      expect(gate).toContain(`"${NO_ACCOUNT_ID_MARKER_HEADER}"`);
      expect(gate).not.toContain('403');
      expect(gate).not.toContain('unexpected credential');
    });

    it('pins the compose project name so environments replace each other', () => {
      const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
      expect(compose).toContain('name: susentorno');
    });

    it('defines both blue and green Envoy services publishing on loopback', () => {
      const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
      expect(compose).toContain('container_name: susentorno-envoy-blue');
      expect(compose).toContain('container_name: susentorno-envoy-green');
      // Host ports are injected per-color by run-hosting; unset -> ephemeral.
      expect(compose).toContain('127.0.0.1:${ENVOY_BLUE_HTTPS_PORT:-}:443');
      expect(compose).toContain('127.0.0.1:${ENVOY_GREEN_HTTPS_PORT:-}:443');
      expect(compose).toContain('127.0.0.1:${ENVOY_BLUE_ADMIN_PORT:-}:9901');
      expect(compose).toContain('127.0.0.1:${ENVOY_GREEN_ADMIN_PORT:-}:9901');
    });
  });

  describe('host firewall templates', () => {
    it('verify-proxy checks the host network model and a stale dedicated-node.exe Query User rule', () => {
      const script = readFileSync(join(templatesDir(), 'proxy', 'verify-proxy.ps1'), 'utf8');
      expect(script).toContain('Get-NetIPInterface');
      expect(script).toContain('WeakHostReceive');
      expect(script).toContain('Forwarding');
      expect(script).toContain('EndsWith($dedicatedNodePath');
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
      expect((script.match(/Test-RuleSet -Label/g) ?? []).length).toBe(4);
    });
  });

  describe('windows pre-/post-isolation step scripts', () => {
    it('windows 01-auth-config parses the double-quoted github-config format', () => {
      const script = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
        'utf8',
      );
      expect(script).toContain('GITHUB_USERNAME');
      expect(script).toContain("Trim('\"')");
    });

    it('windows 01-auth-config fails loudly when gh auth login or setup-git fails', () => {
      const script = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
        'utf8',
      );
      expect(script).toMatch(
        /--with-token\r?\n\s*\$status = \$LASTEXITCODE\r?\n\s*if \(\$status -ne 0\)/,
      );
      expect(script).toMatch(
        /gh auth setup-git[^\n]*\r?\n\s*\$status = \$LASTEXITCODE\r?\n\s*if \(\$status -ne 0\)/,
      );
    });

    it('windows configure-network only verifies reconciled trust; 01-auth-config installs the placeholder', () => {
      const net = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'pre-scripts', 'nn-configure-network.ps1'),
        'utf8',
      );
      // Trust has one owner (the host-driven reconciliation): this step never installs or repairs it.
      expect(net).not.toMatch(/certutil|CertPath|Copy-Item|SetEnvironmentVariable|New-Item/);
      expect(net).not.toContain('proxy-ca.pem');
      expect(net).toContain('NODE_EXTRA_CA_CERTS');
      expect(net).toContain('manifest.json');
      expect(net).toContain('node-extra-ca-bundle.pem');
      expect(net).toContain('http.sslBackend schannel');
      expect(net).toMatch(/http\.sslBackend schannel\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
      const auth = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'),
        'utf8',
      );
      expect(auth).toContain('.credentials.json');
    });

    it('windows verify-config checks the placeholder invariant and gate', () => {
      const v = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'verify-config.ps1'),
        'utf8',
      );
      expect(v).toContain('sk-ant-oat-susentorno-PLACEHOLDER'); // no real token may live in the guest
      expect(v).toContain('api.anthropic.com'); // credential-gate check
      expect(v).toContain('curl.exe'); // live egress via bundled curl
      // trust is checked by DER SHA-256 against the reconciled manifest and bundle, not by subject
      expect(v).not.toContain('susentorno-proxy-certificate-authority');
      expect(v).toContain('manifest.json');
      expect(v).toContain('node-extra-ca-bundle.pem');
    });

    it('windows 01-install-packages ships only the packages a susentorno guest requires', () => {
      const script = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '01-install-packages.ps1'),
        'utf8',
      );
      for (const id of ['jqlang.jq', 'Git.Git', 'GitHub.cli']) expect(script).toContain(id);
      for (const id of [
        'Microsoft.PowerShell',
        'Microsoft.DotNet.SDK',
        'Microsoft.VisualStudioCode',
        'Microsoft.WindowsTerminal',
        'WinMerge.WinMerge',
        'Docker.DockerDesktop',
        'Python.Python',
        'Microsoft.VCRedist',
      ])
        expect(script, id).not.toContain(id);
      expect(script).not.toContain('wsl --update');
    });

    it('windows 02-install-pnpm installs pnpm and nothing python-related', () => {
      const script = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '02-install-pnpm.ps1'),
        'utf8',
      );
      expect(script).toContain('get.pnpm.io/install.ps1');
      expect(script).not.toContain('pip install');
      expect(script).not.toContain('PyYAML');
    });

    it('windows 03-install-tools ships the three agents and no dotnet global tools', () => {
      const script = readFileSync(
        join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '03-install-tools.ps1'),
        'utf8',
      );
      expect(script).toContain('pnpm runtime set node latest -g');
      expect(script).toContain('@earendil-works/pi-coding-agent');
      expect(script).toContain('Anthropic.ClaudeCode');
      expect(script).toContain('@openai/codex');
      expect(script).not.toContain('dotnet tool install');
      expect(script).not.toContain('VS Code');
    });
  });

  describe('shipped Windows steps meet the step contract', () => {
    const steps = [
      'pre-scripts/01-install-packages.ps1',
      'pre-scripts/02-install-pnpm.ps1',
      'pre-scripts/03-install-tools.ps1',
      'pre-scripts/nn-configure-network.ps1',
      'post-scripts/01-auth-config.ps1',
      'post-scripts/02-apply-home-jq-transforms.ps1',
    ];
    const read = (step: string) =>
      readFileSync(join(templatesDir(), 'vm-shared-windows', ...step.split('/')), 'utf8');
    const stepText = (step: string) => read(step).replace(/\r\n/g, '\n');

    /** A statement that starts a native invocation: `& x ...`, or a bare well-known tool. */
    const nativeStart =
      /^\s*(\$\w+\s*=\s*)?(("[^"]*"|'[^']*'|\$\w+(\['[^']*'\])?)\s*\|\s*)?(&\s+\S+|(winget|pnpm|git|gh|node|jq|claude|codex|pi|curl\.exe|powershell\.exe)\s)/;

    it.each(steps)('%s checks $LASTEXITCODE right after every native call', (step) => {
      const lines = stepText(step).split('\n');
      const unchecked: string[] = [];
      lines.forEach((line, i) => {
        if (!nativeStart.test(line) || /^\s*#/.test(line)) return;
        const following = lines
          .slice(i + 1)
          .filter((l) => l.trim() !== '')
          .slice(0, 1);
        if (!/\$LASTEXITCODE/.test(line) && !following.some((l) => /\$LASTEXITCODE/.test(l)))
          unchecked.push(`${i + 1}: ${line.trim()}`);
      });
      expect(unchecked).toEqual([]);
    });

    it.each(steps)('%s never prompts, maps drives, or touches the execution policy', (step) => {
      const text = stepText(step);
      expect(text).not.toMatch(/Read-Host|Get-Credential|-Confirm\b|\bpause\b/);
      expect(text).not.toMatch(/New-PSDrive|net\s+use|subst\s|cmdkey/i);
      expect(text).not.toMatch(/Set-ExecutionPolicy|-Scope\s+(LocalMachine|CurrentUser)/i);
    });

    it.each(steps)('%s tells nobody to open a new terminal', (step) => {
      expect(stepText(step)).not.toMatch(/new terminal/i);
    });

    it.each(steps)('%s never writes under its read-only UNC directory', (step) => {
      const writes = stepText(step)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .filter((line) =>
          /Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|WriteAll|-OutFile|\[System\.IO\.File\]::(Replace|Move|Copy|Delete)|>>?\s/.test(
            line,
          ),
        )
        .filter((line) => /\$shareRoot|\$PSScriptRoot|\$scriptDir/.test(line));
      expect(writes).toEqual([]);
    });

    describe('01-install-packages', () => {
      const script = () => stepText('pre-scripts/01-install-packages.ps1');

      it('no longer changes App Installer, winget settings, or unrelated packages', () => {
        expect(script()).not.toContain('BypassCertificatePinningForMicrosoftStore');
        expect(script()).not.toContain('Microsoft.AppInstaller');
        expect(script()).not.toMatch(/^[^\n#]*\bwinget[^\n]*\bupgrade\b/m);
        expect(script()).not.toContain('winget settings');
      });

      it('checks exact installed state first with the pinned package-absent result', () => {
        expect(script()).toMatch(/list --id \$Id --exact --source winget/);
        expect(script()).toContain('-1978335212');
        expect(script().indexOf('list --id')).toBeLessThan(script().indexOf('install --id'));
      });

      it('installs exactly, silently, and noninteractively from the winget source', () => {
        const install = script()
          .split('\n')
          .find((l) => l.includes('install --id')) as string;
        for (const flag of [
          '--exact',
          '--silent',
          '--accept-source-agreements',
          '--accept-package-agreements',
          '--disable-interactivity',
          '--source winget',
        ])
          expect(install, flag).toContain(flag);
      });

      it('refreshes only the process PATH from persisted values and verifies each tool version', () => {
        expect(script()).toContain("GetEnvironmentVariable('Path', 'Machine')");
        expect(script()).toContain("GetEnvironmentVariable('Path', 'User')");
        expect(script()).not.toContain('SetEnvironmentVariable');
        for (const tool of ['jq', 'git', 'gh']) expect(script(), tool).toContain(`'${tool}'`);
        expect(script()).toContain('--version');
      });
    });

    describe('02-install-pnpm', () => {
      const script = () => stepText('pre-scripts/02-install-pnpm.ps1');

      it('stages the official bootstrap in a unique temp file removed in finally', () => {
        expect(script()).toContain('https://get.pnpm.io/install.ps1');
        expect(script()).not.toContain('Invoke-Expression');
        expect(script()).toMatch(/GetTempPath\(\)/);
        expect(script()).toMatch(/NewGuid\(\)/);
        expect(script()).toMatch(/finally\s*\{[\s\S]*Remove-Item/);
      });

      it('installs the Visual C++ runtime pnpm 12 needs, only when it is absent', () => {
        // Confirmed on the clean golden image: pnpm.exe 12 exits 0xC0000135 (missing
        // vcruntime140.dll) while the official bootstrap still exits 0.
        expect(script()).toContain('vcruntime140.dll');
        expect(script()).toContain('Microsoft.VCRedist.2015+.x64');
        expect(script().indexOf('vcruntime140.dll')).toBeLessThan(script().indexOf('install --id'));
        expect(script().indexOf('install --id')).toBeLessThan(
          script().indexOf('https://get.pnpm.io/install.ps1'),
        );
      });

      it('verifies the persisted PNPM_HOME and PATH resolve pnpm with a zero version exit', () => {
        expect(script()).toContain("GetEnvironmentVariable('PNPM_HOME', 'User')");
        expect(script()).toContain("GetEnvironmentVariable('Path', 'User')");
        expect(script()).toContain('pnpm --version');
      });
    });

    describe('03-install-tools', () => {
      const script = () => stepText('pre-scripts/03-install-tools.ps1');

      it('requires pnpm before any install and checks every pnpm result', () => {
        const firstInstall = script().indexOf('pnpm runtime set');
        expect(script().indexOf('--version')).toBeGreaterThan(-1);
        expect(script().indexOf('--version')).toBeLessThan(firstInstall);
        expect(script()).toContain('pnpm runtime set node latest -g');
        expect(script()).toContain('pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent');
        expect(script()).toContain('pnpm add -g @openai/codex');
      });

      it('installs Claude Code with the exact-state-first winget pattern', () => {
        expect(script()).toContain('Anthropic.ClaudeCode');
        expect(script()).toMatch(/list --id \$Id --exact --source winget/);
        expect(script()).toContain('-1978335212');
        const install = script()
          .split('\n')
          .find((l) => l.includes('install --id')) as string;
        for (const flag of [
          '--exact',
          '--silent',
          '--accept-source-agreements',
          '--accept-package-agreements',
          '--disable-interactivity',
          '--source winget',
        ])
          expect(install, flag).toContain(flag);
      });

      it('verifies node, pi, claude, and codex resolve and report a version', () => {
        for (const tool of ['node', 'pi', 'claude', 'codex'])
          expect(script(), tool).toContain(`'${tool}'`);
      });
    });

    describe('01-auth-config', () => {
      const script = () => stepText('post-scripts/01-auth-config.ps1');

      it('validates all three inputs before any mutation', () => {
        const firstMutation = script().indexOf('git config --global');
        expect(firstMutation).toBeGreaterThan(-1);
        for (const input of ['github-config.txt', 'credentials.json', 'auth.json'])
          expect(script().indexOf(input), input).toBeLessThan(firstMutation);
        expect(script().indexOf('ConvertFrom-Json')).toBeLessThan(firstMutation);
      });

      it('authenticates gh with an explicit hostname and protocol, token on stdin, and setup-git', () => {
        expect(script()).toContain(
          'gh auth login --hostname github.com --git-protocol https --with-token',
        );
        expect(script()).toContain('gh auth setup-git --hostname github.com');
        expect(script()).not.toMatch(/gh auth login[^\n]*--token\b/);
      });

      it('never prints the token', () => {
        expect(script()).not.toMatch(/Write-(Host|Output|Warning|Error)[^\n]*GITHUB_TOKEN/);
        expect(script()).not.toMatch(/(throw|Fail)[^\n]*GITHUB_TOKEN']/);
      });

      it('replaces the Claude and Codex placeholders atomically from a staged file', () => {
        expect(script()).toContain('[System.IO.File]::Replace');
        expect(script()).toContain('.credentials.json');
        expect(script()).toContain("'.codex'");
        expect(script()).toMatch(/finally\s*\{[\s\S]*Remove-Item/);
      });
    });

    describe('02-apply-home-jq-transforms', () => {
      const script = () => stepText('post-scripts/02-apply-home-jq-transforms.ps1');

      it('requires node and jq before invoking the transformer by its $PSScriptRoot path', () => {
        const transformer = script().indexOf('apply-home-jq-transforms.mjs');
        expect(transformer).toBeGreaterThan(-1);
        expect(script().indexOf('node')).toBeLessThan(transformer);
        expect(script().indexOf("'jq'")).toBeLessThan(transformer);
        expect(script()).toContain('$PSScriptRoot');
        expect(script()).toMatch(/exit \$status/);
      });
    });
  });

  describe('ubuntu pre-/post-isolation step scripts', () => {
    it('ubuntu 01-apt-packages installs jq and gh', () => {
      const s = readFileSync(
        join(templatesDir(), 'vm-shared-linux', 'pre-scripts', '01-apt-packages.sh'),
        'utf8',
      );
      expect(s).toMatch(/apt install -y .*\bjq\b/);
      expect(s).toMatch(/apt install -y .*\bgh\b/);
    });

    it('ubuntu pre-scripts install only what a susentorno guest requires', () => {
      const read = (name: string) =>
        readFileSync(join(templatesDir(), 'vm-shared-linux', 'pre-scripts', name), 'utf8');

      const apt = read('01-apt-packages.sh');
      expect(apt).toContain('apt upgrade -y'); // a real setup step, kept deliberately
      expect(apt).not.toContain('okular');
      expect(apt).not.toContain('build-essential');

      const pnpm = read('02-install-pnpm.sh');
      expect(pnpm).toContain('get.pnpm.io/install.sh');
      expect(pnpm).not.toContain('dotnet-sdk');

      const tools = read('03-install-tools.sh');
      expect(tools).toContain('claude.ai/install.sh');
      expect(tools).toContain('chatgpt.com/codex/install.sh');
      expect(tools).toContain('pi-coding-agent');
      expect(tools).toContain('pnpm runtime set node latest -g');
      expect(tools).not.toContain('snap install code');
      expect(tools).not.toContain('dotnet');
    });

    it('ubuntu configure-network leaves addressing and DNS to DHCP', () => {
      const s = readFileSync(
        join(templatesDir(), 'vm-shared-linux', 'pre-scripts', 'nn-configure-network.sh'),
        'utf8',
      );
      expect(s).toContain('come from the host via DHCP');
      expect(s).not.toContain('python3');
    });
  });

  describe('home settings transform manifest', () => {
    it('ships no VS Code settings transform', () => {
      expect(existsSync(join(templatesDir(), 'home-jq-transforms', 'vscode-settings.jq'))).toBe(
        false,
      );
    });

    it('home-jq-transforms manifest and .jq files are consistently wired', () => {
      const dir = join(templatesDir(), 'home-jq-transforms');
      // loadManifest parses manifest.yaml, throws on malformed/non-list YAML, and
      // asserts every entry's transform file exists on disk.
      const entries = loadManifest(dir);
      // Non-empty: loadManifest([]) returns [] without throwing, so an emptied
      // manifest must fail here rather than vacuously pass.
      expect(entries.length).toBeGreaterThan(0);
      const referenced = entries.map((e) => e.transform);
      // Duplicate-free: exactly one manifest entry per seed file.
      expect(new Set(referenced).size).toBe(referenced.length);
      // Exact set equality with the .jq files on disk: no orphaned (unreferenced)
      // files. Combined with loadManifest's existence check, this establishes a
      // one-entry-per-.jq-file relationship without asserting any settings.
      const jqFiles = readdirSync(dir).filter((f) => f.endsWith('.jq'));
      expect([...referenced].sort()).toEqual([...jqFiles].sort());
    });

    it('pi-openai-codex-auth.jq mounts the exact same placeholder access token literal as CODEX_PLACEHOLDER_ACCESS_TOKEN', () => {
      const jq = readFileSync(
        join(templatesDir(), 'home-jq-transforms', 'pi-openai-codex-auth.jq'),
        'utf8',
      );
      expect(jq).toContain(`"access": "${CODEX_PLACEHOLDER_ACCESS_TOKEN}"`);
    });
  });
});
