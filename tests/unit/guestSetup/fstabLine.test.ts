import { describe, it, expect } from 'vitest';
import { buildFstabReplaceCommand } from '../../../src/guestSetup/fstabLine';

describe('buildFstabReplaceCommand', () => {
  it('deletes any existing line for the mount point, then appends the correct one', () => {
    const command = buildFstabReplaceCommand({
      shareName: 'vm-shared-linux',
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(command).toBe(
      "sudo sed -i '\\#[[:space:]]/mnt/vm-shared-linux[[:space:]]#d' /etc/fstab && " +
        "echo '//172.28.128.1/vm-shared-linux /mnt/vm-shared-linux cifs " +
        "ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount 0 0' " +
        '| sudo tee -a /etc/fstab > /dev/null',
    );
  });

  it('quotes a share name containing a single quote', () => {
    const command = buildFstabReplaceCommand({
      shareName: "share'name",
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(command).toContain("/mnt/share'\\''name");
  });

  it('escapes sed/BRE metacharacters in the share name so the delete pattern matches literally', () => {
    // Shell-quoting (above) only protects the guest shell from the string's
    // metacharacters; the delete step's argument is then interpreted a
    // second time, as a sed BRE address, where '.', '#' (our delimiter),
    // etc. mean something different unless escaped.
    const command = buildFstabReplaceCommand({
      shareName: 'share.name#1',
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(command).toContain('/mnt/share\\.name\\#1');
  });
});
