import { describe, expect, it } from 'vitest';
import {
  buildAutounattendXml,
  buildCaCertFiles,
  buildProvisioningScript,
  PROVISIONING_SCRIPT_ISO_FILENAME,
  PROVISIONING_SCRIPT_PATH,
  WINDOWS_GUEST_HOSTNAME,
  WINDOWS_IMAGE_NAME,
} from '../../guest/windowsAutounattend';
import { MINIMUM_SUPPORTED_WINGET_VERSION } from '../../../src/guestSetup/windows/guestChecks';

function wingetBlock(script: string): string {
  return script.slice(
    script.indexOf('if ($stage -eq "winget-ready")'),
    script.indexOf('if ($stage -eq "finalize")'),
  );
}

const xml = buildAutounattendXml({ password: 'p@ssw0rd-Example' });

describe('WINDOWS_GUEST_HOSTNAME', () => {
  it('fits the NetBIOS computer-name limit of 15 characters', () => {
    // Confirmed live: a longer name makes Setup reject the whole unattend.xml
    // as invalid during the specialize pass ("/settings/ComputerName ...
    // Value is invalid"), which surfaces many minutes later, after the first
    // reboot, as the generic "computer restarted unexpectedly" dialog.
    expect(WINDOWS_GUEST_HOSTNAME.length).toBeLessThanOrEqual(15);
  });
});

describe('buildAutounattendXml', () => {
  it('bypasses every Setup hardware gate, including CPU', () => {
    for (const key of [
      'BypassTPMCheck',
      'BypassSecureBootCheck',
      'BypassRAMCheck',
      'BypassCPUCheck',
    ])
      expect(xml, key).toContain(key);
  });

  it('enables the built-in Administrator and skips OOBE entirely', () => {
    expect(xml).toContain('p@ssw0rd-Example');
    expect(xml).toContain('<HideOnlineAccountScreens>true</HideOnlineAccountScreens>');
    expect(xml).toContain('<HideEULAPage>true</HideEULAPage>');
    expect(xml).toContain('<ProtectYourPC>3</ProtectYourPC>');
    expect(xml).toContain(WINDOWS_GUEST_HOSTNAME);
    expect(xml).toContain(WINDOWS_IMAGE_NAME);
  });

  it('names an explicit install target so Setup never falls back to the interactive disk picker', () => {
    // InstallToAvailablePartition=false with no InstallTo leaves Setup with no
    // automatic target at all, and it stops at "Select location to install
    // Windows 11" waiting for input that never comes in an unattended build —
    // confirmed live: the build VM sat there for 37 minutes.
    expect(xml).toContain('<InstallTo>');
    expect(xml).toContain('<DiskID>0</DiskID>');
    // PartitionID 3 is the Primary/Windows partition per DiskConfiguration's
    // CreatePartitions (Order 3) and ModifyPartitions (NTFS, Letter C).
    expect(xml).toContain('<PartitionID>3</PartitionID>');
  });

  it('prevents device encryption and quiets the guest, but does NOT disable Windows Update', () => {
    expect(xml).toContain('PreventDeviceEncryption');
    expect(xml).toContain('DisableStoreAutoUpdate');
    expect(xml).toContain('AllowTelemetry');
    expect(xml).toContain('DisableWindowsConsumerFeatures');
    // Disabling Windows Update here would stop the COM update search finding
    // anything; the provisioning script disables it after servicing.
    expect(xml).not.toContain('NoAutoUpdate');
  });

  it('autologs on with headroom for servicing reboots and launches the provisioner', () => {
    expect(xml).toContain('<LogonCount>10</LogonCount>');
    expect(xml).toContain(PROVISIONING_SCRIPT_PATH);
  });

  it('fetches the provisioning script from the answer-file ISO rather than inlining it', () => {
    // Confirmed live: a CommandLine embedding the whole base64-encoded script
    // hit unattend.xml's ~4096-character field limit and Setup rejected the
    // entire answer file with "Value is invalid" for
    // FirstLogonCommands/SynchronousCommand[Order=1]/CommandLine. Every
    // CommandLine here must stay well under that.
    for (const commandLine of xml.matchAll(/<CommandLine>([^<]*)<\/CommandLine>/g)) {
      expect(commandLine[1].length, commandLine[1]).toBeLessThan(2000);
    }
    expect(xml).toContain(PROVISIONING_SCRIPT_ISO_FILENAME);
    expect(xml).toContain('SUSENTORNO');
    expect(xml).not.toContain(
      Buffer.from(buildProvisioningScript(), 'utf8').toString('base64').slice(0, 100),
    );
  });

  it('escapes XML metacharacters in the password', () => {
    const escaped = buildAutounattendXml({ password: 'a<b>&c"d' });
    expect(escaped).toContain('a&lt;b&gt;&amp;c&quot;d');
    expect(escaped).not.toContain('a<b>&c"d');
  });
});

describe('buildProvisioningScript', () => {
  const script = buildProvisioningScript();

  it('persists across reboots rather than relying on FirstLogonCommands', () => {
    expect(script).toContain('CurrentVersion\\Run');
    expect(script).toContain('SusentornoProvision');
  });

  it('drives Windows Update through the built-in COM API and honours RebootRequired', () => {
    expect(script).toContain('Microsoft.Update.Session');
    expect(script).toContain('RebootRequired');
    expect(script).not.toContain('PSWindowsUpdate');
  });

  it('inspects per-update result codes explicitly rather than only the aggregate', () => {
    expect(script).toContain('GetUpdateResult');
  });

  it('advances by searching again in place when no reboot is required, rather than rebooting unconditionally', () => {
    expect(script).toContain('while ($true)');
    // Finding no further updates must exit the loop without rebooting.
    const noUpdatesBranch = script.match(/if \(\$result\.Updates\.Count -eq 0\) \{[^}]*\}/);
    expect(noUpdatesBranch, 'no-updates-found branch').not.toBeNull();
    expect(noUpdatesBranch![0]).not.toContain('Restart-Computer');
    // Reboot is gated specifically on RebootRequired, not unconditional.
    const rebootBlock = script.match(/if \(\$installResult\.RebootRequired\) \{[^}]*\}/);
    expect(rebootBlock, 'RebootRequired branch').not.toBeNull();
    expect(rebootBlock![0]).toContain('Restart-Computer');
  });

  it('proves WinGet is ready after servicing but installs nothing', () => {
    // The shipped 01-install-packages step installs Git, jq, and GitHub CLI for
    // real, so the golden image carries none of them: only proof that
    // `winget --version` works at the version setup-guest-windows supports.
    expect(script).toContain('"winget-ready"');
    expect(script).not.toContain('"git"');
    expect(script).toContain('--version');
    expect(script).not.toMatch(/winget[^\r\n]*\binstall\b/);
    expect(script).not.toContain('Git.Git');
    expect(script).not.toContain('git.exe');
    expect(script).toContain(MINIMUM_SUPPORTED_WINGET_VERSION);
  });

  it('retries and checks winget rather than silently proceeding on failure', () => {
    // Confirmed live: winget is not yet command-resolvable right after an
    // OOBE-skipped first logon, and an unrecognized command is a terminating
    // PowerShell error under $ErrorActionPreference = 'Stop', not a native exit
    // code. The block must retry, catch, check the native exit code, and fail
    // loudly when every attempt is spent.
    expect(script).toContain('LASTEXITCODE');
    const block = wingetBlock(script);
    expect(block).toMatch(/for\s*\(|while\s*\(/);
    expect(block).toContain('try');
    expect(block).toContain('catch');
    expect(block).toContain('throw');
  });

  it('registers the DesktopAppInstaller package on every attempt before trusting winget', () => {
    // Confirmed live: Microsoft.DesktopAppInstaller is staged in WindowsApps
    // but not yet *registered* for the profile this early after an
    // OOBE-skipped first logon. An unregistered alias is a phantom stub that
    // exits 0 without doing anything, so registration sits inside the retry
    // loop rather than being tried once.
    const block = wingetBlock(script);
    expect(block).toContain('Add-AppxPackage');
    expect(block).toContain('DesktopAppInstaller');
    const loopStart = block.search(/for\s*\(/);
    expect(block.indexOf('Add-AppxPackage')).toBeGreaterThan(loopStart);
  });

  it('reads and compares the reported version rather than trusting the exit code alone', () => {
    // The same phantom-alias failure mode exits 0 with no version output.
    const block = wingetBlock(script);
    expect(block).toContain('[version]');
    expect(block).toMatch(/-ge \$minimumVersion|\$minimumVersion/);
  });

  it('deploys the WinGet source in the interactive session, still installing no package', () => {
    // Confirmed live: the winget source is itself a Store package
    // (Microsoft.Winget.Source) that is deployed per user on first use. A
    // PowerShell Direct session has no interactive logon, so deploying it there
    // fails with 0x80073D19 ("a user was logged off"), and the shipped install
    // step then dies on its first `winget list`. The image therefore deploys
    // the source here, in the autologon session, exactly as first interactive
    // use would. That is a source refresh, not a package install.
    const block = wingetBlock(script);
    expect(block).toContain('source update');
    expect(block).toContain('--name winget');
    expect(block).not.toMatch(/\binstall\b/);
    const versionCheck = block.indexOf('--version');
    expect(block.indexOf('source update')).toBeGreaterThan(versionCheck);
  });

  it('logs the whole provisioning run to a persistent file', () => {
    // Every prior live failure of this stage was diagnosed by mounting the
    // built disk offline and inferring what must have happened from which
    // files existed -- there was never a direct record of what the git
    // stage actually saw or did. Windows writes nothing to serial (see
    // windowsGuestExec.ts), so this script must keep its own record on
    // disk, appended across the reboots servicing requires, so the next
    // build failure (if any) can be root-caused directly instead of by
    // inference from which files happen to exist afterward.
    expect(script).toContain('Start-Transcript');
    expect(script).toContain('-Append');
  });

  it('finalises in the right order: disable updates, clear autologon, deregister, shut down', () => {
    const order = ['NoAutoUpdate', 'AutoAdminLogon', 'Remove-ItemProperty', 'Stop-Computer'];
    let cursor = -1;
    for (const needle of order) {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('records a stage marker so a resumed run knows where it left off', () => {
    expect(script).toContain('susentorno-stage.txt');
  });

  it('imports embedded CA certificates before anything touches the network, on every invocation', () => {
    // Windows Update's COM search and winget both fail TLS validation
    // identically when this host is itself behind an intercepting proxy the
    // build VM has never seen (confirmed live: WININET_E_CANNOT_CONNECT and
    // "Could not establish trust relationship" respectively). The import
    // must therefore run before the stage dispatch, not gated inside a
    // single stage, so it also covers a run resumed straight into "winget-ready".
    // Re-importing an already-trusted cert is a silent no-op, not an error
    // (confirmed against a real LocalMachine\Root store), so running it
    // unconditionally on every invocation costs nothing.
    const stageDispatchIndex = script.indexOf('if ($stage -eq "update")');
    const certImportIndex = script.indexOf('LocalMachine');
    expect(certImportIndex).toBeGreaterThan(-1);
    expect(certImportIndex).toBeLessThan(stageDispatchIndex);
    expect(script).toContain('SUSENTORNO');
    expect(script).toContain('*.pem');
  });

  it('fails loud, not silent, when an embedded cert fails to import', () => {
    const certBlock = script.slice(
      script.indexOf('SUSENTORNO'),
      script.indexOf('if ($stage -eq "update")'),
    );
    expect(certBlock).toContain('catch');
    expect(certBlock).toContain('throw');
  });
});

describe('buildCaCertFiles', () => {
  it('embeds nothing when there are no extra roots to trust', () => {
    expect(buildCaCertFiles([])).toEqual({});
  });

  it('names one uniquely-named .pem file per cert', () => {
    const files = buildCaCertFiles([
      { thumbprint: 'AA', sha256: 'a'.repeat(64), pem: 'PEM-A' },
      { thumbprint: 'BB', sha256: 'b'.repeat(64), pem: 'PEM-B' },
    ]);
    const names = Object.keys(files);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(/\.pem$/);
    expect(Object.values(files).sort()).toEqual(['PEM-A', 'PEM-B']);
  });
});
