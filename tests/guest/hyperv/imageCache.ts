import { join } from 'node:path';
import { repoRoot } from '../../testEnvRoot';

/** The five per-test guests. One differencing disk and one VM each. */
export type GuestRole = 'phases' | 'e2e' | 'fresh' | 'ambientTrust' | 'windowsFresh';

/**
 * One isolation name derives everything this tier touches on the host — the
 * Internal switch and its firewall rules (create-host-network's), plus the VM
 * names, differencing disks, Windows local account, and SMB share below. That
 * is what makes all of it discoverable and sweepable from one string.
 */
export const ISOLATION_NAME = 'test';
export const NAME_PREFIX = `susentorno-${ISOLATION_NAME}`;

/**
 * Repo-local rather than under %LOCALAPPDATA%: this project avoids git
 * worktrees (its live tiers act on one shared host network adapter, so
 * parallel checkouts could not run tests concurrently anyway), so the usual
 * "every worktree rebuilds its own multi-GB image" objection cannot arise.
 * Gitignored and prettier-ignored. No environment-variable override — there is
 * no second consumer.
 */
export const imageCacheDir = join(repoRoot, '.image-cache');

export const isoUrl = 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso';
export const sha256SumsUrl = 'https://releases.ubuntu.com/26.04/SHA256SUMS';
export const isoPath = join(imageCacheDir, 'ubuntu-26.04-live-server-amd64.iso');

export const goldenVhdPath = join(imageCacheDir, `${NAME_PREFIX}-golden.vhdx`);
export const goldenStampPath = `${goldenVhdPath}.stamp`;
/**
 * Deliberately not under test-results/<timestamp>/: a failed build's log has to
 * still be there on the next run, and a per-run directory cannot do that.
 */
export const goldenBuildSerialLogPath = join(imageCacheDir, 'golden-build-serial.log');

/** The client key ssh-agent gets; its public half is baked into the image. */
export const harnessKeyPath = join(imageCacheDir, 'harness_ed25519');
/** The guest's own SSH host key, generated here and installed into the image. */
export const guestHostKeyPath = join(imageCacheDir, 'guest_host_ed25519');

export function roleVhdPath(role: GuestRole): string {
  return join(imageCacheDir, `${NAME_PREFIX}-${role}.vhdx`);
}

export function roleVmName(role: GuestRole): string {
  return `${NAME_PREFIX}-${role}`;
}

export function rolePipeName(role: GuestRole): string {
  return `${NAME_PREFIX}-${role}`;
}

/**
 * Cached parents, never swept. `isSweepableChildVhd` inverts this list rather
 * than excluding one hard-coded filename: with two golden images, an
 * exclusion-of-one predicate silently destroys the other and forces a
 * multi-hour rebuild on every run.
 */
export const GOLDEN_PARENT_VHD_NAMES: readonly string[] = [
  `${NAME_PREFIX}-golden.vhdx`,
  `${NAME_PREFIX}-windows-golden.vhdx`,
];

export const WINDOWS_ISO_ENV_VAR = 'SUSENTORNO_WINDOWS_ISO';
export const WINDOWS_REBUILD_ENV_VAR = 'SUSENTORNO_WINDOWS_IMAGE_REBUILD';

/**
 * Unlike the Ubuntu ISO, the Windows evaluation cannot be downloaded
 * unattended — it sits behind a registration form yielding a short-lived
 * signed URL. The path is therefore supplied, and its absence skips the role
 * rather than failing the tier.
 */
export function windowsIsoPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[WINDOWS_ISO_ENV_VAR];
  return value !== undefined && value.trim() !== '' ? value : null;
}

export const windowsGoldenVhdPath = join(imageCacheDir, `${NAME_PREFIX}-windows-golden.vhdx`);
export const windowsGoldenStampPath = `${windowsGoldenVhdPath}.stamp`;
/** Guest Administrator password, generated once and reused; a stamp input. */
export const windowsCredentialPath = join(imageCacheDir, `${NAME_PREFIX}-windows-credential.json`);
/** The one-file ISO carrying autounattend.xml, attached as a second DVD. */
export const windowsAnswerIsoPath = join(imageCacheDir, `${NAME_PREFIX}-windows-answer.iso`);
/**
 * Deliberately not under test-results/<timestamp>/: like the Ubuntu build's
 * serial log, a failed build's frames have to still be there on the next run.
 */
export const windowsBuildScreenshotDir = join(imageCacheDir, 'windows-build-screenshots');
