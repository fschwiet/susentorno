export const GUEST_USERNAME = 'vmtest';
export const GUEST_HOSTNAME = 'susentorno-test-guest';

export function buildGrubCfg(): string {
  return 'set timeout=1\nmenuentry "autoinstall" {\n  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---\n  initrd /casper/initrd\n}\n';
}

export function buildMetaData(): string {
  return `instance-id: susentorno-test-golden\nlocal-hostname: ${GUEST_HOSTNAME}\n`;
}

export interface AutoinstallInputs {
  harnessPublicKey: string;
  guestHostPrivateKey: string;
  guestHostPublicKey: string;
}
function targetFile(value: string, path: string, mode: string): string[] {
  return [
    `sh -c 'printf %s "${Buffer.from(value).toString('base64')}" | base64 -d > ${path}'`,
    `chmod ${mode} ${path}`,
  ];
}

export function buildUserData(inputs: AutoinstallInputs): string {
  const netplan = Buffer.from(
    'network:\n  version: 2\n  renderer: NetworkManager\n  ethernets:\n    all-en:\n      match:\n        name: "en*"\n      dhcp4: true\n',
  ).toString('base64');
  const commands = [
    'curtin in-target --target=/target -- apt-get update',
    'curtin in-target --target=/target -- apt-get upgrade -y',
    `sh -c 'printf %s "${netplan}" | base64 -d > /target/etc/netplan/01-network-manager-all.yaml' # renderer: NetworkManager`,
    'chmod 600 /target/etc/netplan/01-network-manager-all.yaml',
    'curtin in-target --target=/target -- systemctl mask systemd-networkd.service systemd-networkd.socket systemd-networkd-wait-online.service',
    'curtin in-target --target=/target -- systemctl mask apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer unattended-upgrades.service',
    `sh -c 'printf "%s\\n" "${GUEST_USERNAME} ALL=(ALL) NOPASSWD:ALL" > /target/etc/sudoers.d/90-vmtest-nopasswd'`,
    'chmod 440 /target/etc/sudoers.d/90-vmtest-nopasswd',
    ...targetFile(inputs.guestHostPrivateKey, '/target/etc/ssh/ssh_host_ed25519_key', '600'),
    ...targetFile(inputs.guestHostPublicKey, '/target/etc/ssh/ssh_host_ed25519_key.pub', '644'),
    "sh -c 'rm -f /target/etc/ssh/ssh_host_rsa_key /target/etc/ssh/ssh_host_rsa_key.pub /target/etc/ssh/ssh_host_ecdsa_key /target/etc/ssh/ssh_host_ecdsa_key.pub'",
    `sh -c 'sed -i \\'s/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="console=ttyS0,115200"/\\' /target/etc/default/grub'`,
    'curtin in-target --target=/target -- update-grub',
  ];
  return [
    '#cloud-config',
    'autoinstall:',
    '  version: 1',
    '  interactive-sections: []',
    '  locale: en_US.UTF-8',
    '  keyboard:',
    '    layout: us',
    '  identity:',
    '    realname: susentorno test guest',
    `    username: ${GUEST_USERNAME}`,
    `    hostname: ${GUEST_HOSTNAME}`,
    "    password: '!'",
    '  ssh:',
    '    install-server: true',
    '    allow-pw: false',
    '    authorized-keys:',
    `      - ${JSON.stringify(inputs.harnessPublicKey)}`,
    '  storage:',
    '    layout:',
    '      name: direct',
    '      match:',
    '        size: largest',
    '  packages:',
    '    - network-manager',
    '    - jq',
    '    - linux-cloud-tools-virtual',
    '  late-commands:',
    ...commands.map((command) => `    - ${JSON.stringify(command)}`),
    '  shutdown: poweroff',
    '',
  ].join('\n');
}
