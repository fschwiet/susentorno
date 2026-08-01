import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Single source of truth for where the proxy-stack and guest suites build their
 * `.susentorno` test environment. It lives under `test-results/` (already
 * gitignored, already the guest suite's artifact home) rather than the repo root,
 * so the residue plainly reads as throwaway test output instead of a live
 * susentorno deployment. See
 * docs/honist-v/specs/2026-07-25-relocate-test-environment-design.md.
 */

// This file is at <repo>/tests/, so one `..` reaches the repo root.
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const envParent = join(repoRoot, 'test-results');
export const envRoot = join(envParent, '.susentorno');
