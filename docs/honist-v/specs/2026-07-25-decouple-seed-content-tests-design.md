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

### `tests/unit/templates.test.ts`

Replace `'seed transforms reproduce the extracted inline jq programs'` with a
structural wiring test, using the existing `yaml` dependency to parse
`manifest.yaml`:

```
it('home-jq-transforms manifest and .jq files are consistently wired', () => {
  // parse templates/home-jq-transforms/manifest.yaml
  // every entry's `transform` field names a .jq file that exists in the folder
  // every .jq file in the folder is referenced by at least one manifest entry
});
```

No external binary, no assertions about settings keys/values — only that the
manifest and the files on disk agree with each other.

### `tests/e2e/vmApplier.test.ts`

Replace `'seed transforms reproduce the former inline settings (real jq)'`
with a behavioral test scoped to processing, not output values:

```
it.skipIf(!hasJq)('every seed transform is valid jq that produces valid JSON', () => {
  // parse manifest.yaml
  // for each entry: run `jq -f <transform>` with input '{}'
  // assert exitCode 0 and that stdout parses as JSON
  // (no assertion on which keys/values the transform sets)
});
```

This exercises the real `jq` applier mechanism against the real seed files —
proving each seed transform is runnable and well-formed — without pinning the
settings it produces. The existing `'applies a transform to its target on
this platform (real jq)'` test in the same file already covers the
end-to-end applier mechanism with its own throwaway fixture and needs no
changes.

## Testing

Both new tests should pass against the current (customized) seed files
without modification to `templates/home-jq-transforms/*`. Running the full
suite (`pnpm test`) should go green, including the previously-failing test.
