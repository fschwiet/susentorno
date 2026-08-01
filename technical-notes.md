# Technical notes

Maintainer and background material. Day-to-day setup lives in [README.md](README.md).

## Maintaining the allow list

`current-allow-list.txt` (repo root, source controlled) is the default allow list that `configamatron init` copies into every new environment. To refresh it from an upstream network policy file:

```
configamatron import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` in the current directory by default (`-o` to override). Run it in a checkout of this repository and commit the result. It is a maintenance command — not part of environment setup — and it never touches an environment's own `proxy/allowlist.txt` (edit that file directly for per-environment changes — a running `configamatron run-proxy` picks the edit up live).

## Testing

For the tier model — each tier's test surface, how to place a new test (highest exercised seam wins), and per-tier prerequisites — see [docs/testing.md](docs/testing.md).

One-time WSL setup for the `guest` tier: `wsl.exe -u root bash <repo>/tests/guest/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). Changes to `.wslconfig` take effect after `wsl --shutdown` (Docker Desktop restarts too). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/`.
