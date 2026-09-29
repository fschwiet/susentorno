import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverWindowsStepPlans,
  planWindowsPreIsolationSteps,
} from '../../../../src/guestSetup/windows/stepPlan';
import type { GuestScript } from '../../../../src/guestSetup/listScripts';

const script = (filename: string): GuestScript => ({
  path: `C:\\share\\pre-scripts\\${filename}`,
  filename,
  slug: /^\d{2}-(.+)\.ps1$/i.exec(filename)![1],
});

describe('planWindowsPreIsolationSteps', () => {
  it('accepts a plan with exactly one configure-network step', () => {
    const scripts = [script('01-a.ps1'), script('02-configure-network.ps1'), script('03-b.ps1')];
    expect(planWindowsPreIsolationSteps(scripts)).toEqual({ ok: true, steps: scripts });
  });

  it('rejects a plan with no configure-network step, naming what it requires', () => {
    const result = planWindowsPreIsolationSteps([script('01-a.ps1')]);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.message).toContain('configure-network');
    expect(result.message).toContain('update-shares');
  });

  it('rejects several configure-network steps, listing them', () => {
    const result = planWindowsPreIsolationSteps([
      script('01-configure-network.ps1'),
      script('01-configure-network.PS1'),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('01-configure-network.ps1');
    expect(result.message).toContain('01-configure-network.PS1');
  });

  it('does not count a slug that merely contains configure-network', () => {
    const result = planWindowsPreIsolationSteps([
      script('01-configure-network-extra.ps1'),
      script('02-my-configure-network.ps1'),
    ]);
    expect(result.ok).toBe(false);
  });

  it('allows repeated numeric prefixes', () => {
    const scripts = [script('01-a.ps1'), script('01-configure-network.ps1'), script('01-b.ps1')];
    expect(planWindowsPreIsolationSteps(scripts)).toEqual({ ok: true, steps: scripts });
  });
});

describe('discoverWindowsStepPlans', () => {
  let share: string;
  beforeEach(() => {
    share = mkdtempSync(join(tmpdir(), 'susentorno-step-plan-'));
    mkdirSync(join(share, 'pre-scripts'));
    mkdirSync(join(share, 'post-scripts'));
  });
  afterEach(() => rmSync(share, { recursive: true, force: true }));
  const touch = (...parts: string[]) => writeFileSync(join(share, ...parts), '');

  it('discovers both phase directories in ordinal order and ignores non-matching files', () => {
    touch('pre-scripts', '02-configure-network.ps1');
    touch('pre-scripts', '01-a.PS1');
    touch('pre-scripts', 'README.md');
    touch('pre-scripts', 'helper.ps1');
    touch('pre-scripts', '1-short.ps1');
    touch('pre-scripts', '03-note.sh');
    touch('post-scripts', '02-z.ps1');
    touch('post-scripts', '01-y.ps1');
    const result = discoverWindowsStepPlans(share);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans.pre.map((s) => s.filename)).toEqual([
      '01-a.PS1',
      '02-configure-network.ps1',
    ]);
    expect(result.plans.post.map((s) => s.filename)).toEqual(['01-y.ps1', '02-z.ps1']);
  });

  it('reports a malformed pre plan as a generated-share error', () => {
    touch('pre-scripts', '01-a.ps1');
    const result = discoverWindowsStepPlans(share);
    expect(result.ok).toBe(false);
  });

  it('reports a missing phase directory as a generated-share error', () => {
    rmSync(join(share, 'post-scripts'), { recursive: true });
    touch('pre-scripts', '01-configure-network.ps1');
    const result = discoverWindowsStepPlans(share);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('post-scripts');
  });
});
