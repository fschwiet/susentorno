/**
 * Guard for the Windows-only prerequisites (elevation, Hyper-V, Windows
 * Firewall, the Windows ISO). On any other platform, such as inside a susentorno Linux guest,
 * they cannot be met, so they fail with this message rather than with an opaque
 * PowerShell error, and never pass or skip: the preflight answers "can every
 * tier run here?", and here the answer is no.
 */
export function requireWindowsHost(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    throw new Error(
      `This tier needs a Windows Hyper-V host; this host's platform is ${platform}. ` +
        'Run it on the Windows host instead.',
    );
  }
}
