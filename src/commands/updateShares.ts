import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { previewTransforms } from '../homeJqTransforms';

interface UpdateSharesOptions {
  dryRun: boolean;
}

export function registerUpdateShares(program: Command): void {
  program
    .command('update-shares')
    .description('Preview home-jq-transforms and copy them into the VM shares')
    .option('-n, --dry-run', 'preview only; do not copy', false)
    .action((options: UpdateSharesOptions) => {
      const paths = requireEnvPathsOrExit('update-shares');
      if (!paths) return;

      // Explicit jq preflight: previewTransforms only touches jq once it has an
      // entry to run, so an empty manifest would otherwise pass without jq.
      if (spawnSync('jq', ['--version']).status !== 0) {
        console.error(
          'update-shares: jq is required on the host for the transform preview — install jq and re-run.',
        );
        process.exitCode = 1;
        return;
      }

      let previews;
      try {
        previews = previewTransforms({ dir: paths.homeJqTransforms });
      } catch (error) {
        console.error(`update-shares: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      let hasError = false;
      for (const p of previews) {
        console.log(`\n${p.transform}`);
        console.log(`  linux:   ${p.linuxTarget ?? '(none)'}`);
        console.log(`  windows: ${p.windowsTarget ?? '(none)'}`);
        if (p.error) {
          hasError = true;
          console.error(`  ERROR applying to {}: ${p.error}`);
        } else {
          console.log(`  {} -> ${p.output}`);
        }
      }

      if (hasError) {
        console.error(
          '\nupdate-shares: a transform failed its preview; not copying. Fix the .jq and re-run.',
        );
        process.exitCode = 1;
        return;
      }

      if (options.dryRun) {
        console.log('\nupdate-shares: dry run — no files copied.');
        return;
      }

      for (const target of paths.vmSharedTargets) {
        const live = target.homeJqTransforms;
        const staging = `${live}.staging-${process.pid}`;
        const backup = `${live}.backup-${process.pid}`;
        rmSync(staging, { recursive: true, force: true });
        rmSync(backup, { recursive: true, force: true });
        try {
          // Stage the new copy fully, then swap: move live -> backup, staging ->
          // live, and only then drop the backup. If the promotion throws, restore
          // the backup so the guest is never left without transforms.
          cpSync(paths.homeJqTransforms, staging, { recursive: true });
          if (existsSync(live)) renameSync(live, backup);
          try {
            renameSync(staging, live);
          } catch (promoteError) {
            if (existsSync(backup)) renameSync(backup, live);
            throw promoteError;
          }
          rmSync(backup, { recursive: true, force: true });
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          console.error(`update-shares: failed to update ${live}: ${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`update-shares: copied transforms into ${live}`);
      }
    });
}
