# vm-shared-windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `vm-shared-windows` provisioning kit that isolates and configures a Windows guest VM behind the existing transparent Envoy proxy, and wire the host-side CLI to populate it.

**Architecture:** A parallel `templates/vm-shared-windows/` kit of elevated-PowerShell scripts (`01`–`08`) plus a shipped C# catch-all DNS responder (run as a startup Scheduled Task) that points all guest name resolution at the host proxy IP — reusing the transparent Envoy unchanged. Host-side plumbing makes `init`, `generate-ca`, and `write-github-config` also populate a `.configamatron/vm-shared-windows/` folder, so one environment serves either guest OS.

**Tech Stack:** TypeScript (host CLI, vitest), PowerShell 7 (guest scripts), C# / .NET SDK (DNS responder), winget (guest package install).

## Global Constraints

- **Guest toolset:** git, pnpm, PowerShell 7, .NET SDK, `gh`, plus the claude and codex CLIs and a pnpm-managed node runtime.
- **No real credential in the guest ever.** The guest holds only the placeholder `credentials.json`; the placeholder access token is exactly `sk-ant-oat-SANDBOX-PLACEHOLDER`.
- **Host side is otherwise frozen:** no changes to the Envoy config, allowlist, CA generation, or run-proxy. The only host-code change is populating the `vm-shared-windows` folder.
- **Always populate both folders — no init mode flag.**
- **`github-config.txt` format** is shell-style double-quoted lines: `GITHUB_USERNAME="..."`, `GITHUB_EMAIL="..."`, `GITHUB_TOKEN="..."`.
- **Proxy CA subject** contains the literal `configamatron-proxy-certificate-authority`.
- Guest scripts run from an **elevated (Administrator) PowerShell**; per-user steps write to `%USERPROFILE%`.
- .NET target: **net9.0** / winget id `Microsoft.DotNet.SDK.9` (bump the version digit uniformly if a newer SDK is standard at build time).

---

## File Structure

**New — guest kit (`templates/vm-shared-windows/`):**
- `01-install-packages.ps1` — winget: git, PowerShell 7, .NET SDK, gh
- `02-install-pnpm.ps1` — standalone pnpm
- `03-install-tools.ps1` — node runtime + claude + codex
- `04-configure-tools.ps1` — power timeouts + context7 MCP
- `05-github-auth.ps1` — git identity + gh token login
- `06-trust-ca.ps1` — CA into Windows store + NODE_EXTRA_CA_CERTS + git schannel
- `07-setup-network.ps1` — publish/register the DNS responder, point adapter DNS at it
- `08-claude-config.ps1` — onboarding flag + placeholder credential
- `verify-config.ps1` — read-only PASS/FAIL/WARN diagnostics
- `dns-responder/ConfigamatronDnsResponder.csproj` — C# responder project
- `dns-responder/Program.cs` — C# responder source

**Modified — host CLI:**
- `src/envPaths.ts` — add `VmSharedPaths`, `vmSharedWindows`, `vmSharedTargets`
- `src/initEnv.ts` — copy the windows template, write credentials to both folders
- `src/commands/generateCa.ts` — copy `cert.pem` to both folders
- `src/commands/writeGithubConfig.ts` — write `github-config.txt` to both folders
- `src/commands/init.ts` — update the closing hint

**Modified — tests:**
- `tests/unit/templates.test.ts`, `tests/unit/envPaths.test.ts`, `tests/unit/initEnv.test.ts`, `tests/e2e/generateCa.test.ts`, and a new `tests/e2e/writeGithubConfig.test.ts`

**Modified — docs:**
- `windows-usage.md` → `usage-windows-vm.md` (renamed + expanded)
- `README.md` — pointer to the Windows runbook

---

### Task 1: Guest scripts 01–05 (install, configure, GitHub auth)

**Files:**
- Create: `templates/vm-shared-windows/01-install-packages.ps1`, `02-install-pnpm.ps1`, `03-install-tools.ps1`, `04-configure-tools.ps1`, `05-github-auth.ps1`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: nothing (leaf artifacts).
- Produces: script files the `templates.test.ts` "ships every template file" list and the runbook reference. `05-github-auth.ps1` reads `github-config.txt` (see Global Constraints for its format).

- [ ] **Step 1: Write the failing test** — append the five script paths to the `expectedTemplateFiles` array in `tests/unit/templates.test.ts`, and add a content assertion.

In `tests/unit/templates.test.ts`, add these entries to the `expectedTemplateFiles` array (after the existing `vm-shared/...` block):

```ts
  'vm-shared-windows/01-install-packages.ps1',
  'vm-shared-windows/02-install-pnpm.ps1',
  'vm-shared-windows/03-install-tools.ps1',
  'vm-shared-windows/04-configure-tools.ps1',
  'vm-shared-windows/05-github-auth.ps1',
```

And add this test inside the `describe('templates', ...)` block:

```ts
  it('windows 05-github-auth parses the double-quoted github-config format', () => {
    const script = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '05-github-auth.ps1'),
      'utf8',
    );
    // The config file is GITHUB_USERNAME="..." etc; the parser must strip quotes.
    expect(script).toContain('GITHUB_USERNAME');
    expect(script).toContain("Trim('\"')");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the new files don't exist yet (`existsSync` assertions fail).

- [ ] **Step 3: Create `01-install-packages.ps1`**

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# winget ships with Windows 11. Install non-interactively. Native non-zero exit
# codes (e.g. "package already installed") do not throw in PowerShell, so a
# re-run is safe. Runs while the VM is still on NAT (pre-isolation).
$packages = @(
  'Git.Git',
  'Microsoft.PowerShell',      # PowerShell 7 (pwsh)
  'Microsoft.DotNet.SDK.9',    # .NET SDK
  'GitHub.cli'                 # gh
)
foreach ($id in $packages) {
  Write-Host "01-install-packages: installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements
}

Write-Host "01-install-packages: core packages installed. Open a new terminal so PATH updates apply."
```

- [ ] **Step 4: Create `02-install-pnpm.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

# Standalone pnpm (no Node required yet). Mirrors Ubuntu 02-install-pnpm.sh.
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression

Write-Host "02-install-pnpm: pnpm installed. Open a new terminal before running 03-install-tools.ps1 so pnpm is on PATH."
```

- [ ] **Step 5: Create `03-install-tools.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Claude Code CLI — native Windows installer.
Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

Write-Host "03-install-tools: node, claude, and codex installed. Open a new terminal so PATH updates apply."
```

- [ ] **Step 6: Create `04-configure-tools.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

# Never sleep / never blank the display (analog of Ubuntu's screensaver disable).
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0

# Register the context7 MCP server for both agents (mirrors Ubuntu 04).
claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex."
```

- [ ] **Step 7: Create `05-github-auth.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir 'github-config.txt'

if (-not (Test-Path $configPath)) {
  Write-Error "05-github-auth: $configPath not found. Run 'configamatron write-github-config' on the host first."
  exit 1
}

# github-config.txt is shell-style KEY="value" lines. Strip the surrounding quotes.
$cfg = @{}
foreach ($line in Get-Content $configPath) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim('"') }
}
foreach ($k in 'GITHUB_USERNAME', 'GITHUB_EMAIL', 'GITHUB_TOKEN') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrEmpty($cfg[$k])) {
    Write-Error "05-github-auth: $configPath is missing $k"; exit 1
  }
}

git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
gh auth setup-git

Write-Host "05-github-auth: git identity and gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>"
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add templates/vm-shared-windows/01-install-packages.ps1 templates/vm-shared-windows/02-install-pnpm.ps1 templates/vm-shared-windows/03-install-tools.ps1 templates/vm-shared-windows/04-configure-tools.ps1 templates/vm-shared-windows/05-github-auth.ps1 tests/unit/templates.test.ts
git commit -m "feat: vm-shared-windows install/configure/github scripts (01-05)"
```

---

### Task 2: Guest scripts 06 (CA trust) and 08 (claude config)

**Files:**
- Create: `templates/vm-shared-windows/06-trust-ca.ps1`, `templates/vm-shared-windows/08-claude-config.ps1`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `cert.pem` and `credentials.json` placed in the folder by the host CLI (Tasks 6–7).
- Produces: `06` trusts the CA on three surfaces and writes the stable CA copy to `C:\ProgramData\configamatron\proxy-ca.pem` and the machine env var `NODE_EXTRA_CA_CERTS`; `08` writes `%USERPROFILE%\.claude\.credentials.json`. `verify-config.ps1` (Task 4) checks both.

- [ ] **Step 1: Write the failing test** — append the two paths and content assertions to `tests/unit/templates.test.ts`.

Add to `expectedTemplateFiles`:

```ts
  'vm-shared-windows/06-trust-ca.ps1',
  'vm-shared-windows/08-claude-config.ps1',
```

Add this test:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the two files don't exist.

- [ ] **Step 3: Create `06-trust-ca.ps1`**

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certPath = if ($args.Count -ge 1) { $args[0] } else { Join-Path $scriptDir 'cert.pem' }

if (-not (Test-Path $certPath)) {
  Write-Error "06-trust-ca: $certPath not found. Run 'configamatron generate-ca' on the host first."
  exit 1
}

# 1) Windows machine Root store — covers .NET (uses the store) and schannel.
#    certutil accepts base64 PEM directly.
certutil -f -addstore Root $certPath | Out-Null

# 2) Node tools (claude/codex) ignore the Windows store, so point NODE_EXTRA_CA_CERTS
#    at a stable copy. Machine scope so every new shell inherits it.
$caDir = 'C:\ProgramData\configamatron'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null
$caStable = Join-Path $caDir 'proxy-ca.pem'
Copy-Item -Force $certPath $caStable
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caStable, 'Machine')

# 3) Git for Windows: use the Windows store (schannel) instead of its bundled
#    OpenSSL CA list, which the certutil import above now populates.
git config --global http.sslBackend schannel

Write-Host "06-trust-ca: imported $certPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"
```

- [ ] **Step 4: Create `08-claude-config.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

# The claude CLI refuses to run until ~/.claude.json records onboarding completed.
# Merge the single flag into any existing file; start fresh if missing/unparsable.
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$data = [ordered]@{}
if (Test-Path $claudeJson) {
  try { $data = Get-Content $claudeJson -Raw | ConvertFrom-Json -AsHashtable } catch { $data = @{} }
}
if ($null -eq $data) { $data = @{} }
$data['hasCompletedOnboarding'] = $true
$data | ConvertTo-Json -Depth 100 | Set-Content -Path $claudeJson -Encoding utf8

# Copy the placeholder credential into place. A plain copy (not a symlink, which
# needs admin/Developer Mode) is safe: the placeholder never expires, so the CLI
# never rewrites it. Re-running after `init` regenerates the file re-copies it.
$src = Join-Path $scriptDir 'credentials.json'
Copy-Item -Force $src (Join-Path $claudeDir '.credentials.json')

Write-Host "08-claude-config: set hasCompletedOnboarding in $claudeJson; copied placeholder credential into $claudeDir"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add templates/vm-shared-windows/06-trust-ca.ps1 templates/vm-shared-windows/08-claude-config.ps1 tests/unit/templates.test.ts
git commit -m "feat: vm-shared-windows CA trust (06) and claude config (08) scripts"
```

---

### Task 3: C# DNS responder and network setup (07)

**Files:**
- Create: `templates/vm-shared-windows/dns-responder/ConfigamatronDnsResponder.csproj`, `templates/vm-shared-windows/dns-responder/Program.cs`, `templates/vm-shared-windows/07-setup-network.ps1`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `<host-ip>` as the `07` script argument.
- Produces: a startup Scheduled Task named `ConfigamatronDnsResponder` running the published exe from `C:\ProgramData\configamatron\dns-responder\`, which reads its target IP from `responder-config.txt` in that same directory; the active adapter's DNS set to `127.0.0.1`. `verify-config.ps1` (Task 4) checks the task, the listener on `127.0.0.1:53`, the adapter DNS, and reads `responder-config.txt` to discover the host IP.

- [ ] **Step 1: Write the failing test** — append the three paths and content assertions to `tests/unit/templates.test.ts`.

Add to `expectedTemplateFiles`:

```ts
  'vm-shared-windows/07-setup-network.ps1',
  'vm-shared-windows/dns-responder/ConfigamatronDnsResponder.csproj',
  'vm-shared-windows/dns-responder/Program.cs',
```

Add this test:

```ts
  it('windows DNS redirect wires responder to the host IP and adapter DNS', () => {
    const net = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '07-setup-network.ps1'),
      'utf8',
    );
    expect(net).toContain('Register-ScheduledTask');
    expect(net).toContain('ConfigamatronDnsResponder');
    expect(net).toContain('responder-config.txt'); // host IP written for the responder
    expect(net).toContain("Set-DnsClientServerAddress");
    expect(net).toContain("'127.0.0.1'");

    const prog = readFileSync(
      join(templatesDir(), 'vm-shared-windows', 'dns-responder', 'Program.cs'),
      'utf8',
    );
    expect(prog).toContain('responder-config.txt'); // reads the target IP
    expect(prog).toContain('53'); // binds DNS port
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the three files don't exist.

- [ ] **Step 3: Create `dns-responder/ConfigamatronDnsResponder.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <AssemblyName>ConfigamatronDnsResponder</AssemblyName>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

- [ ] **Step 4: Create `dns-responder/Program.cs`**

```csharp
using System.Net;
using System.Net.Sockets;

// Catch-all DNS stub: answers every A query with the host proxy IP so the guest
// routes all names to the transparent Envoy proxy (the app connects to hostIp:443
// with SNI intact). AAAA queries get NOERROR/no-answer so callers fall back to A.
// The target IP is read from responder-config.txt next to the exe (written by
// 07-setup-network.ps1).

string exeDir = AppContext.BaseDirectory;
string configPath = Path.Combine(exeDir, "responder-config.txt");
string ipText = File.ReadAllText(configPath).Trim();
byte[] ipBytes = IPAddress.Parse(ipText).GetAddressBytes(); // 4 bytes (IPv4)

using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 53));
Console.WriteLine($"ConfigamatronDnsResponder: answering all A queries with {ipText}");

while (true)
{
    IPEndPoint remote = new(IPAddress.Any, 0);
    byte[] query;
    try { query = udp.Receive(ref remote); }
    catch { continue; }

    if (query.Length < 12) continue;
    byte[] response = BuildResponse(query, ipBytes);
    try { udp.Send(response, response.Length, remote); } catch { /* client gone */ }
}

static byte[] BuildResponse(byte[] q, byte[] ip)
{
    // Walk the single QNAME (labels terminated by a zero byte), then read QTYPE.
    int pos = 12;
    while (pos < q.Length && q[pos] != 0) pos += q[pos] + 1;
    int qtypePos = pos + 1;
    if (qtypePos + 3 >= q.Length) return QrEcho(q); // malformed: reply, no answers
    int qtype = (q[qtypePos] << 8) | q[qtypePos + 1];
    int questionEnd = qtypePos + 4;

    using var ms = new MemoryStream();
    ms.WriteByte(q[0]); ms.WriteByte(q[1]);          // copy transaction ID
    ms.WriteByte((byte)(0x80 | (q[2] & 0x01)));      // QR=1, preserve RD
    ms.WriteByte(0x00);                              // RA=0, RCODE=0 (NOERROR)
    ms.WriteByte(0x00); ms.WriteByte(0x01);          // QDCOUNT=1
    ushort ancount = (ushort)(qtype == 1 ? 1 : 0);   // answer only A queries
    ms.WriteByte((byte)(ancount >> 8)); ms.WriteByte((byte)ancount);
    ms.WriteByte(0x00); ms.WriteByte(0x00);          // NSCOUNT=0
    ms.WriteByte(0x00); ms.WriteByte(0x00);          // ARCOUNT=0

    ms.Write(q, 12, questionEnd - 12);               // echo the question verbatim

    if (qtype == 1)
    {
        ms.WriteByte(0xC0); ms.WriteByte(0x0C);          // NAME: pointer to offset 12
        ms.WriteByte(0x00); ms.WriteByte(0x01);          // TYPE A
        ms.WriteByte(0x00); ms.WriteByte(0x01);          // CLASS IN
        ms.WriteByte(0x00); ms.WriteByte(0x00);
        ms.WriteByte(0x00); ms.WriteByte(0x1E);          // TTL 30s
        ms.WriteByte(0x00); ms.WriteByte(0x04);          // RDLENGTH 4
        ms.Write(ip, 0, 4);                              // RDATA (the host IP)
    }
    return ms.ToArray();
}

static byte[] QrEcho(byte[] q)
{
    byte[] r = (byte[])q.Clone();
    r[2] = (byte)(0x80 | (q[2] & 0x01)); // QR=1
    r[3] = 0x00;
    return r;
}
```

- [ ] **Step 5: Create `07-setup-network.ps1`**

```powershell
#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) Publish the shipped C# catch-all DNS responder to a stable location.
$installDir = 'C:\ProgramData\configamatron\dns-responder'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish (Join-Path $scriptDir 'dns-responder') -c Release -o $installDir

# 2) Write the host IP where the responder reads it (analog of dnsmasq-stub.conf).
Set-Content -Path (Join-Path $installDir 'responder-config.txt') -Value $HostIp -NoNewline

# 3) Register a startup Scheduled Task: runs at boot as SYSTEM, restarts on failure.
$exe = Join-Path $installDir 'ConfigamatronDnsResponder.exe'
$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ConfigamatronDnsResponder'

# 4) Point the active adapter's DNS at the local responder; suppress DHCP DNS.
#    Prefer the default-gateway interface; fall back to the first up physical NIC.
$iface = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).InterfaceAlias
if (-not $iface) {
  $iface = (Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1).Name
}
if (-not $iface) { Write-Error "07-setup-network: could not determine the VM's network interface."; exit 1 }
Set-DnsClientServerAddress -InterfaceAlias $iface -ServerAddresses '127.0.0.1'
Clear-DnsClientCache

Write-Host "07-setup-network: DNS responder installed (-> $HostIp), scheduled at startup; adapter '$iface' DNS set to 127.0.0.1"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add templates/vm-shared-windows/07-setup-network.ps1 templates/vm-shared-windows/dns-responder/ConfigamatronDnsResponder.csproj templates/vm-shared-windows/dns-responder/Program.cs tests/unit/templates.test.ts
git commit -m "feat: vm-shared-windows C# DNS responder and network setup (07)"
```

---

### Task 4: `verify-config.ps1` diagnostics

**Files:**
- Create: `templates/vm-shared-windows/verify-config.ps1`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–3 install (CA trust surfaces, responder task/config, placeholder credential).
- Produces: a read-only diagnostic run inside the guest; PASS/FAIL/WARN per check; non-zero exit on any FAIL.

- [ ] **Step 1: Write the failing test** — append the path and a content assertion to `tests/unit/templates.test.ts`.

Add to `expectedTemplateFiles`:

```ts
  'vm-shared-windows/verify-config.ps1',
```

Add this test:

```ts
  it('windows verify-config checks the placeholder invariant and gate', () => {
    const v = readFileSync(join(templatesDir(), 'vm-shared-windows', 'verify-config.ps1'), 'utf8');
    expect(v).toContain('sk-ant-oat-SANDBOX-PLACEHOLDER'); // no real token may live in the guest
    expect(v).toContain('api.anthropic.com'); // credential-gate check
    expect(v).toContain('curl.exe'); // live egress via bundled curl
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — `verify-config.ps1` doesn't exist.

- [ ] **Step 3: Create `verify-config.ps1`**

```powershell
# Read-only diagnostics for the Windows sandbox guest's isolation configuration.
# Usage: powershell -File verify-config.ps1 [host-ip]
#   host-ip  Expected proxy host IP. If omitted, it is discovered from the
#            installed responder config and reported. If given, the config is
#            asserted to match it.
# Prints one PASS/FAIL/WARN line per check; exits non-zero if any FAIL.
param([string]$HostIp)

$script:pass = 0; $script:fail = 0; $script:warn = 0
function Section($t) { Write-Host "`n== $t ==" }
function Ok($m) { $script:pass++; Write-Host "  PASS  $m" }
function Bad($m, $d) { $script:fail++; if ($d) { Write-Host "  FAIL  $m -- $d" } else { Write-Host "  FAIL  $m" } }
function Adv($m, $d) { $script:warn++; if ($d) { Write-Host "  WARN  $m -- $d" } else { Write-Host "  WARN  $m" } }

$PLACEHOLDER = 'sk-ant-oat-SANDBOX-PLACEHOLDER'
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$configFile = Join-Path $installDir 'responder-config.txt'

Section 'Host IP'
$configuredIp = if (Test-Path $configFile) { (Get-Content $configFile -Raw).Trim() } else { '' }
if ($HostIp) {
  if ($configuredIp -eq $HostIp) { Ok "responder config matches requested host IP ($HostIp)" }
  else { Bad 'responder config matches requested host IP' "requested $HostIp, config has '$configuredIp'" }
}
elseif ($configuredIp) { $HostIp = $configuredIp; Ok "discovered host IP from responder config: $HostIp" }
else { Bad 'host IP determinable' 'no responder config and no host-ip arg -- has 07-setup-network.ps1 run?' }

Section 'CA trust (06)'
$root = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like '*configamatron-proxy-certificate-authority*' }
if ($root) { Ok 'proxy CA present in LocalMachine\Root' } else { Bad 'proxy CA present in LocalMachine\Root' 'certutil import missing?' }
$nodeCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
if ($nodeCa -and (Test-Path $nodeCa)) { Ok "NODE_EXTRA_CA_CERTS set ($nodeCa)" } else { Bad 'NODE_EXTRA_CA_CERTS set and file exists' "got '$nodeCa'" }
$sslBackend = (git config --global http.sslBackend) 2>$null
if ($sslBackend -eq 'schannel') { Ok 'git http.sslBackend=schannel' } else { Bad 'git http.sslBackend=schannel' "got '$sslBackend'" }

Section 'DNS redirect (07)'
$task = Get-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -ErrorAction SilentlyContinue
if ($task) { Ok 'responder scheduled task registered' } else { Bad 'responder scheduled task registered' 'Register-ScheduledTask not run?' }
$listening = Get-NetUDPEndpoint -LocalPort 53 -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue
if ($listening) { Ok 'responder listening on 127.0.0.1:53' } else { Bad 'responder listening on 127.0.0.1:53' 'responder process not running?' }
$dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique
if ($dnsServers -contains '127.0.0.1') { Ok 'adapter DNS includes 127.0.0.1' } else { Bad 'adapter DNS includes 127.0.0.1' "got '$($dnsServers -join ', ')'" }
$extra = $dnsServers | Where-Object { $_ -ne '127.0.0.1' }
if (-not $extra) { Ok 'no DNS server besides 127.0.0.1' } else { Bad 'no DNS server besides 127.0.0.1' "extra: $($extra -join ', ')" }
if ($HostIp) {
  try {
    $ans = (Resolve-DnsName -Name example.com -Server 127.0.0.1 -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
    if ($ans -eq $HostIp) { Ok "stub answers example.com -> $HostIp" } else { Bad 'stub answers example.com -> host IP' "got '$ans'" }
  }
  catch { Bad 'stub answers example.com -> host IP' $_.Exception.Message }
}

Section 'Placeholder credential (08)'
$cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $cred)) { Bad 'placeholder credential in place' "missing $cred -- run 08-claude-config.ps1" }
elseif ((Get-Content $cred -Raw).Contains($PLACEHOLDER)) { Ok 'credentials.json is the placeholder' }
else { Bad 'credentials.json is the placeholder' 'a NON-placeholder token is present -- must never live in the guest' }

Section 'Live egress'
function HttpCode($url, $timeout) { & curl.exe -s -o NUL -w '%{http_code}' --max-time $timeout $url }
$c = HttpCode 'http://archive.ubuntu.com/' 20
if ($c -and [int]$c -lt 400) { Ok "allow-listed :80 archive.ubuntu.com -> $c" } else { Bad 'allow-listed :80 archive.ubuntu.com' "code=$c" }
$c = HttpCode 'https://pypi.org/simple/' 30
if ($c -and [int]$c -lt 400) { Ok "allow-listed :443 pypi.org -> $c" } else { Bad 'allow-listed :443 pypi.org' "code=$c" }
& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>$null
if ($LASTEXITCODE -ne 0) { Ok "blocked :443 connection dropped (curlExit=$LASTEXITCODE)" } else { Bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure' }
$c = HttpCode 'http://blocked.example.com/' 20
if ($c -eq '403') { Ok 'blocked :80 -> 403 (default deny)' } else { Bad 'blocked :80 default deny' "expected 403, got $c" }
$c = & curl.exe -s -o NUL -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/
if ($c -eq '403') { Ok 'credential gate: wrong Authorization -> 403 (no token spent)' } else { Bad 'credential gate wrong-auth' "expected 403 from gate.lua, got $c" }

Write-Host "`n$script:pass passed, $script:fail failed, $script:warn warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/vm-shared-windows/verify-config.ps1 tests/unit/templates.test.ts
git commit -m "feat: vm-shared-windows verify-config.ps1 diagnostics"
```

---

### Task 5: Host — `envPaths` gains the Windows shared-folder target

**Files:**
- Modify: `src/envPaths.ts`
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**
- Produces: `EnvPaths.vmSharedWindows: string`; `EnvPaths.vmSharedTargets: VmSharedPaths[]` (element 0 = Ubuntu `vm-shared`, element 1 = `vm-shared-windows`), where `VmSharedPaths = { dir: string; cert: string; credentials: string; githubConfig: string }`. The existing `vmCert` / `vmCredentials` / `githubConfig` keep pointing at the Ubuntu folder (element 0) for backward compatibility.

- [ ] **Step 1: Write the failing test** — add assertions to `tests/unit/envPaths.test.ts` inside the existing `it('maps a cwd to the environment layout', ...)`.

Append these assertions before the closing `});` of that test:

```ts
    // Windows guest shared folder + the both-folders target list.
    expect(paths.vmSharedWindows).toBe(join(root, 'vm-shared-windows'));
    expect(paths.vmSharedTargets).toHaveLength(2);
    expect(paths.vmSharedTargets[0]).toEqual({
      dir: join(root, 'vm-shared'),
      cert: join(root, 'vm-shared', 'cert.pem'),
      credentials: join(root, 'vm-shared', 'credentials.json'),
      githubConfig: join(root, 'vm-shared', 'github-config.txt'),
    });
    expect(paths.vmSharedTargets[1]).toEqual({
      dir: join(root, 'vm-shared-windows'),
      cert: join(root, 'vm-shared-windows', 'cert.pem'),
      credentials: join(root, 'vm-shared-windows', 'credentials.json'),
      githubConfig: join(root, 'vm-shared-windows', 'github-config.txt'),
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — `vmSharedWindows` / `vmSharedTargets` are undefined.

- [ ] **Step 3: Implement in `src/envPaths.ts`**

Add the interface above `EnvPaths`:

```ts
export interface VmSharedPaths {
  dir: string;
  cert: string;
  credentials: string;
  githubConfig: string;
}
```

Add these fields to the `EnvPaths` interface (after `vmShared`):

```ts
  vmSharedWindows: string;
  vmSharedTargets: VmSharedPaths[];
```

In `envPaths()`, replace the body between `const vmShared = ...` and the `return {` with:

```ts
  const vmShared = join(root, 'vm-shared');
  const vmSharedWindows = join(root, 'vm-shared-windows');
  const proxy = join(root, 'proxy');
  const target = (dir: string): VmSharedPaths => ({
    dir,
    cert: join(dir, 'cert.pem'),
    credentials: join(dir, 'credentials.json'),
    githubConfig: join(dir, 'github-config.txt'),
  });
  const vmSharedTargets = [target(vmShared), target(vmSharedWindows)];
```

And update the returned object so it includes the new fields and derives the Ubuntu file paths from `vmSharedTargets[0]`:

```ts
  return {
    root,
    vmShared,
    vmSharedWindows,
    vmSharedTargets,
    proxy,
    allowlist: join(proxy, 'allowlist.txt'),
    envoyConfig: join(proxy, 'envoy.yaml'),
    caDir: join(proxy, 'ca'),
    caCert: join(proxy, 'ca', 'cert.pem'),
    caKey: join(proxy, 'ca', 'key.pem'),
    caLeafCert: join(proxy, 'ca', 'leaf-cert.pem'),
    caLeafKey: join(proxy, 'ca', 'leaf-key.pem'),
    secretsDir: join(proxy, 'secrets'),
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    vmCert: vmSharedTargets[0].cert,
    vmCredentials: vmSharedTargets[0].credentials,
    githubConfig: vmSharedTargets[0].githubConfig,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat: envPaths exposes vm-shared-windows and vmSharedTargets"
```

---

### Task 6: Host — `init` copies the Windows template and writes credentials to both folders

**Files:**
- Modify: `src/initEnv.ts`
- Test: `tests/unit/initEnv.test.ts`

**Interfaces:**
- Consumes: `paths.vmSharedWindows`, `paths.vmSharedTargets` from Task 5; the `templates/vm-shared-windows/` files from Tasks 1–4.
- Produces: `.configamatron/vm-shared-windows/` populated with the template + sanitized `credentials.json`; the Ubuntu folder still gets its `credentials.json` too.

- [ ] **Step 1: Write the failing test** — extend `tests/unit/initEnv.test.ts`.

Add these entries to the `for (const file of [...])` list in the first test (after the existing `vm-shared/...` entries):

```ts
      'vm-shared-windows/01-install-packages.ps1',
      'vm-shared-windows/07-setup-network.ps1',
      'vm-shared-windows/verify-config.ps1',
      'vm-shared-windows/dns-responder/Program.cs',
      'vm-shared-windows/credentials.json',
```

Add a new test after the first one:

```ts
  it('writes the sanitized placeholder credential into both shared folders', () => {
    initEnvironment(options());
    const root = join(dir, ENV_DIR_NAME);
    for (const folder of ['vm-shared', 'vm-shared-windows']) {
      const credentials = readFileSync(join(root, folder, 'credentials.json'), 'utf8');
      expect(JSON.parse(credentials).claudeAiOauth.accessToken, folder).toBe(
        'sk-ant-oat-SANDBOX-PLACEHOLDER',
      );
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/initEnv.test.ts`
Expected: FAIL — the `vm-shared-windows` files/credentials are not created.

- [ ] **Step 3: Implement in `src/initEnv.ts`**

Replace the four write lines at the end of `initEnvironment` (from `cpSync(join(options.templatesDir, 'vm-shared'), ...)` through `writeFileSync(paths.vmCredentials, sanitized);`) with:

```ts
  cpSync(join(options.templatesDir, 'vm-shared'), paths.vmShared, { recursive: true });
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
  });
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  for (const target of paths.vmSharedTargets) {
    writeFileSync(target.credentials, sanitized);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/initEnv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/initEnv.ts tests/unit/initEnv.test.ts
git commit -m "feat: init scaffolds vm-shared-windows and writes credentials to both folders"
```

---

### Task 7: Host — `generate-ca` and `write-github-config` populate both folders

**Files:**
- Modify: `src/commands/generateCa.ts`, `src/commands/writeGithubConfig.ts`
- Test: `tests/e2e/generateCa.test.ts`, `tests/e2e/writeGithubConfig.test.ts` (new)

**Interfaces:**
- Consumes: `paths.vmSharedTargets` from Task 5.
- Produces: `cert.pem` in both folders (`generate-ca`); `github-config.txt` in both folders (`write-github-config`).

- [ ] **Step 1: Write the failing e2e test for `generate-ca`** — extend `tests/e2e/generateCa.test.ts`.

Add this accessor near the other path helpers (after `vmCert`):

```ts
const vmWindowsCert = () => join(dir, '.configamatron', 'vm-shared-windows', 'cert.pem');
```

Add these assertions inside the first test (`writes the root CA and a leaf...`), after the existing `vm-shared gets the ROOT` assertion:

```ts
    // The Windows shared folder gets the same root cert.pem.
    expect(readFileSync(vmWindowsCert(), 'utf8')).toBe(readFileSync(caCert(), 'utf8'));
```

- [ ] **Step 2: Write the new e2e test for `write-github-config`** — create `tests/e2e/writeGithubConfig.test.ts`.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

let dir: string;
let gitConfig: string;
// A syntactically valid fine-grained PAT: the validator requires exactly 93 chars
// (the 'github_pat_' prefix + 82 body chars of [A-Za-z0-9_]). See src/githubToken.ts.
const token = 'github_pat_' + 'A'.repeat(82);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'configamatron-ghcfg-'));
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
  // Hermetic global git identity via a scratch config the command will read.
  gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = { GIT_CONFIG_GLOBAL: gitConfig };
  await execa('git', ['config', '--global', 'user.name', 'octo'], { env });
  await execa('git', ['config', '--global', 'user.email', 'octo@example.com'], { env });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configamatron write-github-config', () => {
  it('writes github-config.txt into both shared folders', async () => {
    const { exitCode } = await execa('node', [cliPath, 'write-github-config'], {
      cwd: dir,
      input: token + '\n',
      env: { GIT_CONFIG_GLOBAL: gitConfig },
    });
    expect(exitCode).toBe(0);

    for (const folder of ['vm-shared', 'vm-shared-windows']) {
      const cfg = readFileSync(join(dir, '.configamatron', folder, 'github-config.txt'), 'utf8');
      expect(cfg, folder).toContain('GITHUB_USERNAME="octo"');
      expect(cfg, folder).toContain('GITHUB_EMAIL="octo@example.com"');
      expect(cfg, folder).toContain(`GITHUB_TOKEN="${token}"`);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/generateCa.test.ts tests/e2e/writeGithubConfig.test.ts`
Expected: FAIL — `vm-shared-windows/cert.pem` and `vm-shared-windows/github-config.txt` are not written yet.

- [ ] **Step 4: Implement `generate-ca`** — in `src/commands/generateCa.ts`, replace:

```ts
      const leafStatus = ensureLeaf(paths, caCertPem, caKeyPem, sans);
      copyFileSync(paths.caCert, paths.vmCert);
      console.log(`generate-ca: ${caStatus}; ${leafStatus}; copied cert.pem to vm-shared`);
```

with:

```ts
      const leafStatus = ensureLeaf(paths, caCertPem, caKeyPem, sans);
      for (const target of paths.vmSharedTargets) {
        copyFileSync(paths.caCert, target.cert);
      }
      console.log(
        `generate-ca: ${caStatus}; ${leafStatus}; copied cert.pem to vm-shared and vm-shared-windows`,
      );
```

- [ ] **Step 5: Implement `write-github-config`** — in `src/commands/writeGithubConfig.ts`, replace:

```ts
      mkdirSync(dirname(paths.githubConfig), { recursive: true });
      writeFileSync(paths.githubConfig, formatGithubConfig({ username, email, token }));

      console.log(`write-github-config: wrote ${paths.githubConfig} for ${username} <${email}>`);
```

with:

```ts
      for (const target of paths.vmSharedTargets) {
        mkdirSync(dirname(target.githubConfig), { recursive: true });
        writeFileSync(target.githubConfig, formatGithubConfig({ username, email, token }));
      }

      console.log(
        `write-github-config: wrote github-config.txt to vm-shared and vm-shared-windows for ${username} <${email}>`,
      );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/generateCa.test.ts tests/e2e/writeGithubConfig.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/generateCa.ts src/commands/writeGithubConfig.ts tests/e2e/generateCa.test.ts tests/e2e/writeGithubConfig.test.ts
git commit -m "feat: generate-ca and write-github-config populate vm-shared-windows too"
```

---

### Task 8: Documentation — Windows runbook + pointers

**Files:**
- Create: `usage-windows-vm.md`
- Delete: `windows-usage.md`
- Modify: `README.md`, `src/commands/init.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the Windows-guest runbook and pointers to it.

- [ ] **Step 1: Create `usage-windows-vm.md`** (absorbs and replaces the `windows-usage.md` stub)

```markdown
# Windows guest VM setup

Provision a Windows guest that runs the claude/codex agents against Windows-specific
work, isolated behind the host proxy. Complete host "Proxy setup" (README.md) first,
so `.configamatron/vm-shared-windows/` contains `cert.pem`, `github-config.txt`, and
`credentials.json`.

## Create the VM

- In VMware Workstation, create a Windows 11 VM. Leave the network as **NAT** for
  initial setup (pre-isolation).
- In network settings, disable "Connect at power on" to avoid needing a Windows account.
- Install Windows, then install **VMware Tools** (enables Shared Folders).

## Share the environment folder

Shut the VM down, then in VM → Settings → Options → Shared Folders: enable only the
environment's `.configamatron\vm-shared-windows` folder, read-only. In a Windows guest
the share appears at `\\vmware-host\Shared Folders\vm-shared-windows` (the analog of
Ubuntu's `/mnt/hgfs`).

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**, `cd` to the shared folder, and run the
scripts in order. Open a **new terminal** where noted so PATH changes take effect.

1. `.\01-install-packages.ps1`
2. `.\02-install-pnpm.ps1`
3. New terminal, then `.\03-install-tools.ps1`
4. New terminal, then `.\04-configure-tools.ps1`
5. `.\05-github-auth.ps1`
6. `.\06-trust-ca.ps1` — trusts the proxy CA (defaults to the `cert.pem` beside the script).
7. `.\07-setup-network.ps1 <host-ip>` — `<host-ip>` is printed by proxy setup step 5.
   Publishes the DNS responder, registers it as a startup task, and points the VM's DNS at it.
8. `.\08-claude-config.ps1` — sets the onboarding flag and installs the placeholder credential.
9. Switch the VM's network from NAT to **host-only**, then reboot so the isolation takes effect.

## Verify

Inside the VM, run `.\verify-config.ps1 [host-ip]`. It prints one PASS/FAIL/WARN line per
check and exits non-zero if anything failed. Omit `host-ip` to have it discover and report
the value from the installed responder config.
```

- [ ] **Step 2: Delete the old stub**

```bash
rm windows-usage.md
```

- [ ] **Step 3: Add a pointer in `README.md`** — at the end of the "VM setup" section's intro (right after the line `May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.`), add:

```markdown

> For a **Windows** guest instead of Ubuntu, follow `usage-windows-vm.md` and share the
> `.configamatron\vm-shared-windows` folder. The steps below cover the Ubuntu guest.
```

- [ ] **Step 4: Update the `init` closing hint** — in `src/commands/init.ts`, replace:

```ts
      console.log(`  Then share ${ENV_DIR_NAME}/vm-shared into the VM — see usage.md`);
```

with:

```ts
      console.log(
        `  Then share ${ENV_DIR_NAME}/vm-shared (Ubuntu, see README.md) or ` +
          `${ENV_DIR_NAME}/vm-shared-windows (Windows, see usage-windows-vm.md) into the VM`,
      );
```

- [ ] **Step 5: Verify the rename and pointers**

Run:
```bash
test -f usage-windows-vm.md && test ! -f windows-usage.md && grep -q vm-shared-windows README.md && echo OK
```
Expected: `OK`

- [ ] **Step 6: Build to confirm `init.ts` still compiles**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add usage-windows-vm.md README.md src/commands/init.ts
git commit -m "docs: Windows guest runbook (usage-windows-vm.md) and pointers"
```

---

## Final verification

- [ ] **Run the full host verification pipeline**

Run: `pnpm test`
Expected: all steps (format, lint, typecheck, unit, build, e2e) pass.

Note: `pnpm test:vm` (Ubuntu QEMU harness) is unrelated to this work and unaffected. There is no automated Windows-VM harness by design; the guest kit is verified manually in a real Windows VM via `verify-config.ps1` (see `usage-windows-vm.md`).

---

## Self-Review notes (traceability to spec)

- **Networking (DNS redirect, C# responder, startup task):** Task 3.
- **Host plumbing (envPaths / init / generate-ca / write-github-config, both folders, no mode flag):** Tasks 5–7.
- **Guest scripts 01–08, elevated shell, no Playwright/Firefox, copy-not-symlink credential:** Tasks 1–3.
- **CA trust three surfaces, git schannel:** Task 2.
- **verify-config.ps1 incl. placeholder invariant + gate check:** Task 4.
- **Testing (host TS via vitest; guest via verify-config.ps1; no auto Windows harness):** Tasks 1–7 + Final verification.
- **Docs (rename to usage-windows-vm.md, expand runbook, README pointer):** Task 8.
- **Toolset git/pnpm/PowerShell 7/.NET SDK/gh/claude/codex:** Task 1 + Task 3.
