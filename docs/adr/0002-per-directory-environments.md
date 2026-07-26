# Store each environment under its owning working directory

Every deployment is rooted at `<cwd>/.configamatron`, and commands operate on that directory without searching parents or accepting a separate environment path. This keeps generated configuration, VM shares, certificates, and secrets out of the Configamatron source tree and prevents environments from overwriting one another, while accepting that the fixed proxy identity and public ports allow only one environment's proxy to run at a time.
