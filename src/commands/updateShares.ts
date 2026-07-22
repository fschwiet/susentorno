import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { previewTransforms } from '../homeJqTransforms';
import { planAllPhases, executePlans, type PhasePlan } from '../weaveShares';
import { templatesDir } from '../templates';

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

      let plans: PhasePlan[];
      try {
        plans = planAllPhases({ templatesDir: templatesDir(), paths });
      } catch (error) {
        console.error(`update-shares: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      const homeJqPlans: PhasePlan[] = paths.vmSharedTargets.map((target) => ({
        livePhaseDir: target.homeJqTransforms,
        actions: [{ kind: 'dir', src: paths.homeJqTransforms, destRel: '.' }],
      }));

      if (options.dryRun) {
        console.log('\nupdate-shares: dry run — no files copied.');
        return;
      }

      executePlans([...plans, ...homeJqPlans]);
      console.log(
        'update-shares: rewove pre/post scripts and refreshed home-jq-transforms in both shares',
      );
    });
}
