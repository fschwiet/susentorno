import { describe, expect, it } from 'vitest';
import {
  buildAutounattendXml,
  buildProvisioningScript,
  PROVISIONING_SCRIPT_PATH,
  WINDOWS_GUEST_HOSTNAME,
  WINDOWS_IMAGE_NAME,
} from '../../guest/windowsAutounattend';

const xml = buildAutounattendXml({
  password: 'p@ssw0rd-Example',
  provisioningScript: buildProvisioningScript(),
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

  it('escapes XML metacharacters in the password', () => {
    const escaped = buildAutounattendXml({
      password: 'a<b>&c"d',
      provisioningScript: 'x',
    });
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

  it('installs git after servicing', () => {
    expect(script).toContain('winget install');
    expect(script).toContain('Git.Git');
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
});
