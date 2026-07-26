# Generate cross-platform VM provisioning from authored overlays

Configamatron ships built-in Ubuntu and Windows provisioning steps, then deterministically weaves user-authored pre- and post-isolation scripts and sibling resources into generated, read-only VM shares. User inputs are committed under `.configamatron`, while generated shares, host-specific files, and credentials are ignored and rebuilt by `init` or `update-shares`; this supports customization without asking users to fork packaged templates or commit derived secrets.
