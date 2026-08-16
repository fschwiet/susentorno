import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildGrubCfg,
  buildMetaData,
  buildUserData,
  GUEST_HOSTNAME,
  GUEST_USERNAME,
} from '../../guest/autoinstall';

const inputs = {
  harnessPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHARNESS harness@susentorno',
  guestHostPrivateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n',
  guestHostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY susentorno-test-guest',
};

describe('autoinstall seed generators', () => {
  it('writes a serial, consented GRUB entry and metadata', () => {
    expect(buildGrubCfg()).toBe(
      'set timeout=1\nmenuentry "autoinstall" {\n  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---\n  initrd /casper/initrd\n}\n',
    );
    expect(parse(buildMetaData())).toEqual({
      'instance-id': 'susentorno-test-golden',
      'local-hostname': GUEST_HOSTNAME,
    });
  });
  it('produces valid, noninteractive user data for the known harness keys', () => {
    const yaml = buildUserData(inputs);
    const ai = parse(yaml).autoinstall;
    expect(yaml.startsWith('#cloud-config\n')).toBe(true);
    expect(ai.identity).toMatchObject({
      username: GUEST_USERNAME,
      hostname: GUEST_HOSTNAME,
      password: '!',
    });
    expect(ai.ssh).toMatchObject({
      'install-server': true,
      'allow-pw': false,
      'authorized-keys': [inputs.harnessPublicKey],
    });
    expect(ai.storage.layout).toEqual({ name: 'direct', match: { size: 'largest' } });
    expect(ai.packages).toEqual(
      expect.arrayContaining(['network-manager', 'jq', 'linux-cloud-tools-virtual']),
    );
    expect(ai.packages).not.toEqual(
      expect.arrayContaining(['cifs-utils', 'nodejs', 'npm', 'pnpm', 'dnsmasq']),
    );
    const commands = ai['late-commands'].join('\n');
    expect(commands).toContain('apt-get upgrade -y');
    expect(commands).toContain('systemd-networkd.service');
    expect(commands).toContain('apt-daily.timer');
    expect(commands).toContain('renderer: NetworkManager');
    expect(commands).toContain(`${GUEST_USERNAME} ALL=(ALL) NOPASSWD:ALL`);
    expect(commands).toContain(Buffer.from(inputs.guestHostPrivateKey).toString('base64'));
    expect(commands).toContain('/target/etc/ssh/ssh_host_ed25519_key');
    expect(commands).toContain('ssh_host_rsa_key');
    expect(commands).toContain('GRUB_CMDLINE_LINUX_DEFAULT="console=ttyS0,115200"');
    expect(commands).toContain('update-grub');
    for (const command of ai['late-commands'])
      expect(command.includes('curtin in-target') || command.includes('/target/')).toBe(true);
    expect(ai.shutdown).toBe('poweroff');
    expect(buildUserData({ ...inputs, harnessPublicKey: 'changed' })).not.toBe(yaml);
  });
});
