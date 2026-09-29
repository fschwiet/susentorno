import { join } from 'node:path';
import { listScripts, WINDOWS_STEP_NAMING, type GuestScript } from '../listScripts';

/** The one pre-isolation step that alone receives `-HostIp`. */
export const CONFIGURE_NETWORK_SLUG = 'configure-network';

export interface WindowsStepPlans {
  pre: GuestScript[];
  post: GuestScript[];
}

export type WindowsStepPlanResult =
  { ok: true; plans: WindowsStepPlans } | { ok: false; message: string };

const REGENERATE = "run 'susentorno update-shares' to regenerate the Windows VM share";

/**
 * A pre-isolation plan needs exactly one step whose slug is exactly
 * `configure-network`. Zero or several is a structural generated-share error.
 */
export function planWindowsPreIsolationSteps(
  scripts: GuestScript[],
): { ok: true; steps: GuestScript[] } | { ok: false; message: string } {
  const matches = scripts.filter((script) => script.slug === CONFIGURE_NETWORK_SLUG);
  if (matches.length === 1) return { ok: true, steps: scripts };
  const found =
    matches.length === 0
      ? 'none was found'
      : `${matches.length} were found (${matches.map((m) => m.filename).join(', ')})`;
  return {
    ok: false,
    message:
      `The generated pre-scripts must contain exactly one '${CONFIGURE_NETWORK_SLUG}' step, but ${found}. ` +
      `Check the customization's pre-scripts, then ${REGENERATE}.`,
  };
}

/**
 * Discovers both phase directories of the host's generated Windows VM share
 * (`NN-name.ps1`, ordinal order, everything else ignored) and validates the
 * pre-isolation plan. A problem is a message, never a throw, so the flow can
 * fail before any secret prompt.
 */
export function discoverWindowsStepPlans(vmSharedWindowsPath: string): WindowsStepPlanResult {
  const discover = (directory: 'pre-scripts' | 'post-scripts'): GuestScript[] | string => {
    try {
      return listScripts(join(vmSharedWindowsPath, directory), WINDOWS_STEP_NAMING);
    } catch (error) {
      return (
        `Could not read '${directory}' in ${vmSharedWindowsPath}: ` +
        `${error instanceof Error ? error.message : String(error)} — ${REGENERATE}.`
      );
    }
  };
  const pre = discover('pre-scripts');
  if (typeof pre === 'string') return { ok: false, message: pre };
  const post = discover('post-scripts');
  if (typeof post === 'string') return { ok: false, message: post };
  const planned = planWindowsPreIsolationSteps(pre);
  if (!planned.ok) return planned;
  return { ok: true, plans: { pre: planned.steps, post } };
}
