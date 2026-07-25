# Decouple home-jq-transforms tests from seed content

## Problem

`templates/home-jq-transforms/vscode-settings.jq` and `claude-onboarding.jq` are
customizable seed files — maintainers edit them over time to change the default
settings a new environment applies (e.g. adding `chat.disableAIFeatures`). Two
tests hardcode the literal output/content of these files, so editing the seed
data (not a bug, a legitimate customization) breaks the test suite:

- `tests/e2e/vmApplier.test.ts` → `'seed transforms reproduce the former inline
  settings (real jq)'` runs the real seed `.jq` files through `jq` and asserts
  the exact resulting JSON object.
- `tests/unit/templates.test.ts` → `'seed transforms reproduce the extracted
  inline jq programs'` asserts the seed `.jq` files `toContain` specific jq
  expressions.

Both tests should instead verify that the *processing* of `home-jq-transforms`
(manifest wiring, jq execution) works, without asserting what settings the
seed data actually produces.

## Scope

Limited to the two tests above. `templates/vm-shared/pre-scripts` and
`templates/vm-shared/post-scripts` were considered (their seed scripts are
also part of the customizable `.configamatron` surface per the README's
"Customizing setup scripts" section), but their content-asserting tests in
`templates.test.ts` (`installs jq and gh`, `fails loudly when gh auth login or
setup-git fails`, `covers CA trust surfaces`, etc.) test operational
invariants of script *logic*, not swappable data — and for the Windows-guest
scripts specifically, they're the only automated coverage that exists (the
real-VM harness in `tests/vm/vm.test.ts` only exercises the Ubuntu/WSL2
guest). Those tests are left unchanged.

## Design

Both replacements reuse the production API in `src/homeJqTransforms.ts` rather
than re-parsing YAML or shelling out to `jq` by hand. That module already
exports `loadManifest(dir)` (parses `manifest.yaml`, validates each entry, and
— via `validateEntry` — throws if a referenced `.jq` file is missing) and
`previewTransforms({ dir })` (runs each transform through real `jq` with `'{}'`
input, returning `{ output }` or `{ error }` per entry). Reusing them means the
tests exercise the real code path instead of a parallel reimplementation, add
less code, and can't drift from production behavior.

The two new tests divide the coverage: the unit test guarantees no `.jq` file
is orphaned (unreferenced files never get run elsewhere), and the e2e test runs
every referenced transform. Neither alone is complete — a file present but
unreferenced would be skipped by the entry-driven e2e test — but together they
cover the seed folder.

### `tests/unit/templates.test.ts`

Replace `'seed transforms reproduce the extracted inline jq programs'` with a
structural wiring test. `loadManifest` already enforces that every entry's
`transform` names an existing file, so the test only adds the two checks it
does not do — the manifest is non-empty, and no `.jq` file is orphaned:

```
it('home-jq-transforms manifest and .jq files are consistently wired', () => {
  // const entries = loadManifest(templates/home-jq-transforms)
  //   (this alone already asserts every entry.transform file exists, and
  //    throws on malformed/non-list YAML)
  // assert entries.length > 0 — loadManifest([]) returns [] without throwing,
  //   so an emptied manifest must be caught here, not vacuously pass
  // glob *.jq in the folder; assert each is referenced by some entry.transform
});
```

No external binary, no assertions about settings keys/values — only that the
manifest and the files on disk agree with each other.

### `tests/e2e/vmApplier.test.ts`

Replace `'seed transforms reproduce the former inline settings (real jq)'`
with a behavioral test scoped to processing, not output values, driven by
`previewTransforms` (which already loads the manifest and runs each transform
through real `jq` with `'{}'` input):

```
it.skipIf(!hasJq)('every seed transform is valid jq that produces a JSON object', () => {
  // const results = previewTransforms({ dir: seedDir })
  // for each result:
  //   assert result.error is undefined (jq exited 0 and ran)
  //   JSON.parse(result.output) is a non-null, non-array object (not just
  //   "any valid JSON value" — a transform reduced to `.` or `{}` should not
  //   silently pass; no assertion on which keys/values it sets)
});
```

This proves each seed transform is runnable, well-formed jq, and yields an
object shape usable as a settings file — without pinning the settings it
produces. It exercises the production loader and `jq` runner against the seed
programs; the existing `'applies a transform to its target on this platform
(real jq)'` test in the same file is what covers the end-to-end applier
mechanism (write/atomic-rename), with its own throwaway fixture, and needs no
changes.

Note this overlaps in mechanics with `tests/unit/homeJqTransforms.test.ts`,
which already exercises `loadManifest` and `previewTransforms` with a stub
runner. The new value here is validating the *seed* content specifically:
its structural wiring (non-empty, no orphans) and that its real programs are
valid jq producing objects — neither of which the stub-driven module tests
cover.

## Trade-offs

The replaced tests protected two things: that transforms are valid/runnable,
and that the shipped defaults contain the historically-intended settings.
This design keeps the former and deliberately drops the latter — pinning
"shipped defaults are correct" is exactly the fragility this change removes.
A transform reduced to `{}` (an empty but valid object) would still pass;
that's accepted as the cost of not asserting on customizable content, not an
oversight.

## Testing

Both new tests should pass against the current (customized) seed files
without modification to `templates/home-jq-transforms/*`. Running the full
suite (`pnpm test`) should go green, including the previously-failing test.
