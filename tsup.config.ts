import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'apply-home-jq-transforms': 'src/vmApplyHomeJqTransforms.ts',
  },
  format: ['esm'],
  target: 'node18',
  clean: true,
  // The VM applier bundle must be self-contained (no node_modules in the guest),
  // so inline yaml. Other deps are used only by cli.js, which has node_modules.
  noExternal: ['yaml'],
  // yaml's CJS build calls require('process'); ESM output has no ambient
  // `require`, so this injects a createRequire-based shim for it.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Without this, tsup shares a chunk file between cli.js and the applier entry
  // (both import yaml) — but only the single .js file gets copied into the VM
  // shares, so the copy would import a sibling chunk that isn't there.
  splitting: false,
});
