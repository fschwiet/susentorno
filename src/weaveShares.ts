import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EnvPaths } from './envPaths';
import {
  readFolderContents,
  renumber,
  type OrderedScript,
  type ScriptExtension,
} from './weaveScripts';
import { detectCollisions, type Collision, type WeaveItem } from './collisions';
import { generateMcpRegistrationScript } from './mcpRegistrationStep';
import type { McpServer } from './mcpServers';

export interface WeaveAction {
  kind: 'file' | 'dir';
  src: string;
  destRel: string;
}
export interface PhasePlan {
  livePhaseDir: string;
  actions: WeaveAction[];
}

export interface WeaveAllPhasesOptions {
  templatesDir: string;
  paths: EnvPaths;
  /** Declared Host MCP servers; when non-empty, a generated post-isolation step is
   *  woven into `post-scripts` for both platforms (see `mcpRegistrationStep.ts`). */
  mcpServers?: McpServer[];
}

export function planAllPhases(opts: WeaveAllPhasesOptions): PhasePlan[] {
  const platforms = [
    { ext: 'sh' as const, template: 'vm-shared', output: opts.paths.vmShared, insensitive: false },
    {
      ext: 'ps1' as const,
      template: 'vm-shared-windows',
      output: opts.paths.vmSharedWindows,
      insensitive: true,
    },
  ];
  const plans: PhasePlan[] = [];
  const errors: string[] = [];
  const mcpServers = opts.mcpServers ?? [];
  for (const phase of ['pre-scripts', 'post-scripts']) {
    for (const platform of platforms) {
      try {
        const generatedScript =
          phase === 'post-scripts' && mcpServers.length > 0
            ? stageMcpRegistrationScript(mcpServers, platform.ext)
            : undefined;
        plans.push(
          planPhase({
            builtinPhaseDir: join(opts.templatesDir, platform.template, phase),
            customPhaseDir: join(opts.paths.root, phase),
            outPhaseDir: join(platform.output, phase),
            extension: platform.ext,
            caseInsensitive: platform.insensitive,
            generatedScript,
          }),
        );
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n\n'));
  return plans;
}

/**
 * Writes the generated MCP registration step to a fresh staging file so it can
 * flow through the same file-copy `WeaveAction` as every other script. The
 * staging directory is left for the OS to reclaim; the file is tiny and
 * `executePlans` may run well after this function returns (or, on a dry run,
 * never), so it cannot be cleaned up here.
 */
function stageMcpRegistrationScript(
  servers: McpServer[],
  ext: ScriptExtension,
): { sourcePath: string; remainder: string } {
  const remainder = `register-mcp-servers.${ext}`;
  const stagingDir = mkdtempSync(join(tmpdir(), 'cfgm-mcp-'));
  const sourcePath = join(stagingDir, remainder);
  writeFileSync(sourcePath, generateMcpRegistrationScript(servers, ext));
  return { sourcePath, remainder };
}

function planPhase(opts: {
  builtinPhaseDir: string;
  customPhaseDir: string;
  outPhaseDir: string;
  extension: ScriptExtension;
  caseInsensitive: boolean;
  /** A generated step (e.g. MCP server registration) to weave in like a built-in
   *  script — after the packaged built-ins, before customization inputs. */
  generatedScript?: { sourcePath: string; remainder: string };
}): PhasePlan {
  const builtin = readFolderContents({
    dir: opts.builtinPhaseDir,
    extension: opts.extension,
    allowSentinel: true,
    strictExtension: true,
  });
  const custom = readFolderContents({
    dir: opts.customPhaseDir,
    extension: opts.extension,
    allowSentinel: false,
    strictExtension: false,
  });
  const generated: OrderedScript[] = opts.generatedScript
    ? [
        {
          sourcePath: opts.generatedScript.sourcePath,
          sourceName: opts.generatedScript.remainder,
          remainder: opts.generatedScript.remainder,
          ext: opts.extension,
          sentinel: false,
        },
      ]
    : [];
  const labeled: { script: OrderedScript; label: 'built-in' | 'custom' | 'generated' }[] = [
    ...builtin.scripts
      .filter((s) => !s.sentinel)
      .map((script) => ({ script, label: 'built-in' as const })),
    ...generated.map((script) => ({ script, label: 'generated' as const })),
    ...custom.scripts.map((script) => ({ script, label: 'custom' as const })),
    ...builtin.scripts
      .filter((s) => s.sentinel)
      .map((script) => ({ script, label: 'built-in' as const })),
  ];
  const numbered = renumber(labeled.map(({ script }) => script));
  const actions: WeaveAction[] = [];
  const items: WeaveItem[] = [];
  numbered.forEach((script, index) => {
    actions.push({ kind: 'file', src: script.sourcePath, destRel: script.outputName });
    items.push({
      destPath: script.outputName,
      kind: 'file',
      origin: `${labeled[index].label} script ${script.outputName}`,
    });
  });
  for (const [label, entries] of [
    ['built-in', builtin.passthrough],
    ['custom', custom.passthrough],
  ] as const) {
    for (const entry of entries) {
      actions.push({
        kind: entry.isDirectory ? 'dir' : 'file',
        src: entry.sourcePath,
        destRel: entry.name,
      });
      if (entry.isDirectory) expandDir(entry.sourcePath, entry.name, label, items);
      else
        items.push({
          destPath: entry.name,
          kind: 'file',
          origin: `${label} resource ${entry.name}`,
        });
    }
  }
  const collisions = detectCollisions(items, { caseInsensitive: opts.caseInsensitive });
  if (collisions.length) throw new Error(formatCollisions(opts.outPhaseDir, collisions));
  return { livePhaseDir: opts.outPhaseDir, actions };
}

function expandDir(absDir: string, relBase: string, label: string, out: WeaveItem[]): void {
  out.push({ destPath: relBase, kind: 'dir', origin: `${label} resource ${relBase}/` });
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) expandDir(join(absDir, entry.name), rel, label, out);
    else out.push({ destPath: rel, kind: 'file', origin: `${label} resource ${rel}` });
  }
}

function formatCollisions(dir: string, collisions: Collision[]): string {
  return `resource/script collisions in ${dir}:\n${collisions.map((c) => `  - ${c.destPath}: ${c.reason} (${c.a} vs ${c.b})`).join('\n')}`;
}

export function executePlans(plans: PhasePlan[]): void {
  const staged: { live: string; staging: string }[] = [];
  try {
    for (const plan of plans) {
      const staging = `${plan.livePhaseDir}.staging-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      staged.push({ live: plan.livePhaseDir, staging });
      for (const action of plan.actions) {
        const dest = join(staging, action.destRel);
        mkdirSync(dirname(dest), { recursive: true });
        if (action.kind === 'dir')
          cpSync(action.src, dest, {
            recursive: true,
            filter: () => true,
          });
        else copyFileSync(action.src, dest);
      }
    }
  } catch (error) {
    for (const item of staged) rmSync(item.staging, { recursive: true, force: true });
    throw error;
  }
  const swapped: { live: string; backup: string; hadLive: boolean }[] = [];
  try {
    for (const { live, staging } of staged) {
      const backup = `${live}.backup-${process.pid}`;
      rmSync(backup, { recursive: true, force: true });
      const hadLive = existsSync(live);
      if (hadLive) renameSync(live, backup);
      swapped.push({ live, backup, hadLive });
      renameSync(staging, live);
    }
  } catch (error) {
    for (const { live, backup, hadLive } of swapped) {
      rmSync(live, { recursive: true, force: true });
      if (hadLive && existsSync(backup)) renameSync(backup, live);
    }
    for (const { staging } of staged) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  for (const { backup } of swapped) rmSync(backup, { recursive: true, force: true });
}

export function weaveShares(opts: WeaveAllPhasesOptions): void {
  executePlans(planAllPhases(opts));
}
