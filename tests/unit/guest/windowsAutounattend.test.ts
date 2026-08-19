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
