import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface FstabReplaceOptions {
  shareName: string;
  hostIp: string;
}

/**
 * Idempotent /etc/fstab update for the cifs mount line: delete any existing
 * line for this mount point (matched by [[:space:]]-bounded field, so it
 * can't false-positive on a longer directory name), then append the correct
 * line fresh. Safe both for a same-content rerun and for a rerun after
 * `hostIp` changed — whether that's the Default-Switch host IP drifting
 * across a host reboot, or the guest moving from the Default Switch to
 * susentorno-internal — either way this converges on one correct line,
 * unlike a plain `tee -a`.
 */
/**
 * Escapes a value for safe use inside a GNU sed BRE address between '#'
 * delimiters: '\\', '.', '*', '[', ']', '^', '$' are BRE metacharacters, and
 * '#' is the chosen delimiter itself — GNU sed treats a backslash-escaped
 * delimiter inside the address as a literal character. Shell-quoting
 * (quoteForRemoteShell) protects the guest shell from the string; this
 * separately protects sed's own interpretation of it once delivered.
 */
function escapeForSedBre(value: string): string {
  return value.replace(/[\\.*[\]^$#]/g, '\\$&');
}

export function buildFstabReplaceCommand(opts: FstabReplaceOptions): string {
  const mountPoint = `/mnt/${opts.shareName}`;
  const fstabLine =
    `//${opts.hostIp}/${opts.shareName} ${mountPoint} cifs ` +
    `ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount 0 0`;
  // '#' as the sed delimiter avoids escaping the '/' characters in mountPoint.
  const deleteScript = `\\#[[:space:]]${escapeForSedBre(mountPoint)}[[:space:]]#d`;
  return (
    `sudo sed -i ${quoteForRemoteShell(deleteScript)} /etc/fstab && ` +
    `echo ${quoteForRemoteShell(fstabLine)} | sudo tee -a /etc/fstab > /dev/null`
  );
}
