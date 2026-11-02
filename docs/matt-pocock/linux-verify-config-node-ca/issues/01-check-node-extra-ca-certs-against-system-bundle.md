# 01: Ubuntu verify-config.sh checks NODE_EXTRA_CA_CERTS against a path the guest no longer uses

**Status:** resolved

**Category:** bug

**Blocked by:** None (can start immediately).

## What happened

`templates/vm-shared-linux/verify-config.sh` checks the login-shell value of `NODE_EXTRA_CA_CERTS` like this:

```bash
node_ca="$(bash -lc 'echo $NODE_EXTRA_CA_CERTS')"
if printf '%s' "$node_ca" | grep -q 'susentorno-proxy-certificate-authority.crt'; then
  ok 'NODE_EXTRA_CA_CERTS set for login shells'
```

The guest stopped pointing `NODE_EXTRA_CA_CERTS` at the single proxy CA file in commit `40e5807` (2026-08-16, "point NODE_EXTRA_CA_CERTS at the full system bundle, not one file"). Both writers now set `/etc/ssl/certs/ca-certificates.crt`:

- `templates/vm-shared-linux/pre-scripts/nn-configure-network.sh` (`/etc/profile.d/node-extra-ca-certs.sh`);
- `src/guestSetup/unix/ambientTrust.ts` `buildSetNodeExtraCaCertsCommand` (`/etc/environment`).

`40e5807` updated `nn-configure-network.sh` and `tests/guest/phases.test.ts`, but not `verify-config.sh`. So on a correctly configured guest this check should always report `FAIL NODE_EXTRA_CA_CERTS set for login shells`, making `verify-config.sh` exit non-zero. That is from reading the code: no one has run it on a guest to confirm.

No test runs `verify-config.sh`, which is why this went unnoticed. `tests/unit/templates.test.ts` only checks the Windows `verify-config.ps1` text; `diagnostics.md` documents running `verify-config.sh` by hand inside the VM.

Found during the code review for `golden-image-build-stall/issues/01-pin-primary-mirror.md`, while adding a `CLAUDE_CODE_DISABLE_SELF_NAMED_CERT_DROP` check next to this one.

## What to build

- Make the check assert what the guest actually sets: `NODE_EXTRA_CA_CERTS` equals `/etc/ssl/certs/ca-certificates.crt`. The proxy CA's presence in that bundle is already checked just above (`proxy CA present in system trust bundle`), so this check does not need to repeat it.
- Add a test that would have caught the drift. At minimum, a `tests/unit/templates.test.ts` assertion that `verify-config.sh` expects the same path the writers set. Check `testing.md` for whether running `verify-config.sh` on the phases guest is a sensible guest-tier test; it makes real outbound requests to allow-listed hosts.

## Acceptance

1. `verify-config.sh` passes its `NODE_EXTRA_CA_CERTS` check on a guest configured by the current templates and setup.
2. A test fails if `verify-config.sh` and the writers disagree on the path again.
3. `pnpm test:unit` passes, plus any tier the new test lands in.

## Comments

### 2026-11-02: Implemented

`verify-config.sh` now passes the check only when `NODE_EXTRA_CA_CERTS` equals `/etc/ssl/certs/ca-certificates.crt` (commit `473f282`). A new `tests/unit/templates.test.ts` case reads the path `nn-configure-network.sh` exports and fails if `verify-config.sh` checks anything else. That covers acceptance 2. `pnpm check` passes, covering acceptance 3.

Acceptance 1 is **not verified**: no one has run `verify-config.sh` on a guest since the change, and no test runs it. I did not add a guest-tier test for it, because the script makes real outbound requests to allow-listed hosts.

### 2026-11-02: Reviewed and resolved

The changeset review (`3d64fa4..HEAD`) found one gap here: the test compared `verify-config.sh` only against `nn-configure-network.sh`. It now also checks `buildSetNodeExtraCaCertsCommand`, so both writers are covered (acceptance 2). This ticket's function name was corrected to match.

Acceptance 1 is covered indirectly. `tests/guest/phases.test.ts` (`configures NODE_EXTRA_CA_CERTS for login shells, pointing at the full system bundle`) reads the login-shell value on a real Ubuntu guest. That is the value the new check compares, and the test passed in the last full `pnpm check`. `verify-config.sh` itself has still not been run on a guest.

Last full `pnpm check` passed at `2cec18d`, which includes this fix. The later commits (`2450001`, `12f790f`) changed only tests, docs, and a small `src/ca.ts` refactor. Unit tests (1454) and lint/typecheck pass on them; the guest tiers were not re-run.
