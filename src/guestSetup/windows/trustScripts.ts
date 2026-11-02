import { X509Certificate } from 'node:crypto';
import { quoteForPowerShell } from '../quoteForPowerShell';
import type { TrustCertificate, TrustManifest } from './trustPlanner';

/**
 * Where the guest's managed trust state lives. The shipped `configure-network`
 * step and `verify-config.ps1` read these same paths to verify, never to repair.
 */
export const GUEST_TRUST_DIR = 'C:\\ProgramData\\susentorno\\trust';
export const GUEST_TRUST_MANIFEST_FILE = 'manifest.json';
export const GUEST_TRUST_PROXY_FILE = 'proxy-ca.pem';
export const GUEST_TRUST_BUNDLE_FILE = 'node-extra-ca-bundle.pem';
export const GUEST_TRUST_BUNDLE_PATH = `${GUEST_TRUST_DIR}\\${GUEST_TRUST_BUNDLE_FILE}`;

const derBase64 = (cert: TrustCertificate): string =>
  new X509Certificate(cert.pem).raw.toString('base64');
const textBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/**
 * Every trust script starts with `# susentorno trust: <operation>`, sets Stop, and
 * carries the same few helpers. Certificates cross as base64 DER (or base64 PEM for
 * files) so no character of them can break a string, and no script ever reads a
 * certificate's subject: everything is keyed by DER SHA-256.
 */
function header(operation: string): string[] {
  return [
    `# susentorno trust: ${operation}`,
    "$ErrorActionPreference = 'Stop'",
    `$trustDir = ${quoteForPowerShell(GUEST_TRUST_DIR)}`,
    'function Get-Sha256Hex([byte[]]$Bytes) {',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) -join "") }',
    '  finally { $sha.Dispose() }',
    '}',
    'function Open-RootStore([string]$Mode) {',
    '  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")',
    '  $store.Open($Mode)',
    '  return $store',
    '}',
  ];
}

/** Runs `body`, which sets `$result`; any terminating error becomes a compact error verdict. */
function wrap(body: string[]): string[] {
  return [
    '$fingerprint = $null',
    'try {',
    ...body.map((line) => `  ${line}`),
    '} catch {',
    "  $result = @{ Outcome = 'error'; Fingerprint = $fingerprint; Message = $_.Exception.Message }",
    '}',
    '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 6 $result))',
  ];
}

const ENSURE_TRUST_DIRECTORY = [
  'function Ensure-TrustDirectory {',
  '  if (-not (Test-Path -LiteralPath $trustDir -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($trustDir) }',
  '  # Machine trust must not be writable by unprivileged users: SYSTEM and Administrators only, Users read.',
  '  $acl = Get-Acl -LiteralPath $trustDir',
  '  $acl.SetAccessRuleProtection($true, $false)',
  '  foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRule($existing) }',
  "  $rules = @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))",
  '  foreach ($rule in $rules) {',
  '    $sid = New-Object System.Security.Principal.SecurityIdentifier($rule[0])',
  "    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rule[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '  }',
  '  Set-Acl -LiteralPath $trustDir -AclObject $acl',
  '}',
  'function Write-AtomicFile([string]$Path, [byte[]]$Bytes) {',
  "  $staging = Join-Path $trustDir ('.staging-' + [guid]::NewGuid().ToString('N'))",
  '  try {',
  '    [System.IO.File]::WriteAllBytes($staging, $Bytes)',
  '    if (Test-Path -LiteralPath $Path -PathType Leaf) { [System.IO.File]::Replace($staging, $Path, [NullString]::Value) }',
  '    else { [System.IO.File]::Move($staging, $Path) }',
  '  } finally {',
  '    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }',
  '  }',
  '}',
];

/** The guest's `LocalMachine\Root` fingerprints plus the managed trust directory's contents, unparsed. */
export function buildInspectScript(): string {
  return [
    ...header('inspect'),
    ...wrap([
      "$store = Open-RootStore 'ReadOnly'",
      'try { $roots = @($store.Certificates | ForEach-Object { Get-Sha256Hex $_.RawData }) } finally { $store.Close() }',
      '$manifest = $null; $proxyFile = $null; $files = @()',
      'if (Test-Path -LiteralPath $trustDir -PathType Container) {',
      `  $manifestPath = Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_MANIFEST_FILE)}`,
      '  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {',
      '    $manifest = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($manifestPath))',
      '  }',
      `  $proxyPath = Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_PROXY_FILE)}`,
      '  if (Test-Path -LiteralPath $proxyPath -PathType Leaf) {',
      '    $proxyFile = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($proxyPath))',
      '  }',
      "  $files = @(Get-ChildItem -LiteralPath $trustDir -File | Where-Object { $_.Name -like 'ambient-*.pem' } |",
      '    ForEach-Object { @{ Name = $_.Name; Base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($_.FullName)) } })',
      '}',
      "$result = @{ Outcome = 'ok'; Roots = $roots; Manifest = $manifest; ProxyFile = $proxyFile; Files = $files }",
    ]),
  ].join('\n');
}

/** The guest's `LocalMachine\Root` fingerprints only, for verification. */
export function buildListRootsScript(): string {
  return [
    ...header('roots'),
    ...wrap([
      "$store = Open-RootStore 'ReadOnly'",
      'try { $roots = @($store.Certificates | ForEach-Object { Get-Sha256Hex $_.RawData }) } finally { $store.Close() }',
      "$result = @{ Outcome = 'ok'; Roots = $roots }",
    ]),
  ].join('\n');
}

/** Write each ambient certificate to `ambient-<sha256>.pem`, atomically. */
export function buildWriteAmbientPemsScript(roots: TrustCertificate[]): string {
  const items = roots.map(
    (root) =>
      `@{ Sha = ${quoteForPowerShell(root.sha256)}; Pem64 = ${quoteForPowerShell(textBase64(root.pem))} }`,
  );
  return [
    ...header('write-ambient-pems'),
    ...ENSURE_TRUST_DIRECTORY,
    ...wrap([
      `$items = @(${items.join(', ')})`,
      'Ensure-TrustDirectory',
      'foreach ($item in $items) {',
      '  $fingerprint = $item.Sha',
      "  Write-AtomicFile (Join-Path $trustDir ('ambient-' + $item.Sha + '.pem')) ([Convert]::FromBase64String($item.Pem64))",
      '}',
      "$result = @{ Outcome = 'ok'; Written = $items.Count }",
    ]),
  ].join('\n');
}

/** Add certificates to `LocalMachine\Root` only, refusing any whose DER does not hash to its fingerprint. */
export function buildImportScript(operation: string, roots: TrustCertificate[]): string {
  const items = roots.map(
    (root) =>
      `@{ Sha = ${quoteForPowerShell(root.sha256)}; Der64 = ${quoteForPowerShell(derBase64(root))} }`,
  );
  return [
    ...header(operation),
    ...wrap([
      `$items = @(${items.join(', ')})`,
      "$store = Open-RootStore 'ReadWrite'",
      'try {',
      '  foreach ($item in $items) {',
      '    $fingerprint = $item.Sha',
      '    $der = [Convert]::FromBase64String($item.Der64)',
      "    if ((Get-Sha256Hex $der) -ne $item.Sha) { throw 'the certificate does not hash to its fingerprint' }",
      '    $store.Add([System.Security.Cryptography.X509Certificates.X509Certificate2]::new($der))',
      '  }',
      '} finally { $store.Close() }',
      "$result = @{ Outcome = 'ok'; Imported = $items.Count }",
    ]),
  ].join('\n');
}

/**
 * Publish the proxy PEM, the combined bundle, and the manifest, each replaced
 * atomically. The manifest goes last: it is the commit point, and an interruption
 * before it leaves the previous complete state.
 */
export function buildPublishScript(input: {
  manifest: TrustManifest;
  bundlePem: string;
  proxy: TrustCertificate;
}): string {
  const manifestText = `${JSON.stringify(input.manifest, null, 2)}\n`;
  return [
    ...header('publish'),
    ...ENSURE_TRUST_DIRECTORY,
    ...wrap([
      'Ensure-TrustDirectory',
      `Write-AtomicFile (Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_PROXY_FILE)}) ([Convert]::FromBase64String(${quoteForPowerShell(textBase64(input.proxy.pem))}))`,
      `Write-AtomicFile (Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_BUNDLE_FILE)}) ([Convert]::FromBase64String(${quoteForPowerShell(textBase64(input.bundlePem))}))`,
      `Write-AtomicFile (Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_MANIFEST_FILE)}) ([Convert]::FromBase64String(${quoteForPowerShell(textBase64(manifestText))}))`,
      "$result = @{ Outcome = 'ok' }",
    ]),
  ].join('\n');
}

/**
 * Point machine-scoped NODE_EXTRA_CA_CERTS at the bundle and verify both: the
 * bundle holds exactly the expected fingerprints, once each, and the variable
 * reads back as the bundle's path.
 */
export function buildSetEnvironmentScript(expectedBundle: string[]): string {
  return [
    ...header('set-environment'),
    ...wrap([
      `$expected = @(${expectedBundle.map(quoteForPowerShell).join(', ')})`,
      `$bundlePath = Join-Path $trustDir ${quoteForPowerShell(GUEST_TRUST_BUNDLE_FILE)}`,
      "if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) { throw 'the combined bundle is missing' }",
      '$text = [System.IO.File]::ReadAllText($bundlePath)',
      "$blocks = [regex]::Matches($text, '-----BEGIN CERTIFICATE-----(?<body>[A-Za-z0-9+/=\\s]+?)-----END CERTIFICATE-----')",
      "$found = @($blocks | ForEach-Object { Get-Sha256Hex ([Convert]::FromBase64String(($_.Groups['body'].Value -replace '\\s', ''))) })",
      "if ($found.Count -ne @($found | Sort-Object -Unique).Count) { throw 'the combined bundle contains a duplicate certificate' }",
      '$missing = @($expected | Where-Object { $found -notcontains $_ })',
      '$extra = @($found | Where-Object { $expected -notcontains $_ })',
      "if ($missing.Count -gt 0) { $fingerprint = $missing[0]; throw ('the combined bundle is missing ' + $missing.Count + ' expected certificate(s)') }",
      "if ($extra.Count -gt 0) { $fingerprint = $extra[0]; throw ('the combined bundle holds ' + $extra.Count + ' unexpected certificate(s)') }",
      "[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $bundlePath, 'Machine')",
      "$actual = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')",
      "if ($actual -ne $bundlePath) { throw 'machine NODE_EXTRA_CA_CERTS did not read back as the bundle path' }",
      "$result = @{ Outcome = 'ok'; Certificates = $found.Count }",
    ]),
  ].join('\n');
}

/** Remove the certificate with this DER SHA-256 from `LocalMachine\Root`. */
export function buildRemoveProxyScript(sha256: string): string {
  return [
    ...header('remove-proxy'),
    ...wrap([
      `$fingerprint = ${quoteForPowerShell(sha256)}`,
      "$store = Open-RootStore 'ReadWrite'",
      'try {',
      '  $found = @($store.Certificates | Where-Object { (Get-Sha256Hex $_.RawData) -eq $fingerprint })',
      '  foreach ($certificate in $found) { $store.Remove($certificate) }',
      '} finally { $store.Close() }',
      "$result = @{ Outcome = 'ok'; Removed = $found.Count }",
    ]),
  ].join('\n');
}
