# Proxy Access Log Diagnostic Fields Implementation Plan

**Goal:** Extend the raw Envoy access log line (`CFGM|...`, visible via `docker compose logs envoy` on the host) with the actual HTTP response code, Envoy's failure flags, request duration, and response bytes sent — so an operator can tell "the request succeeded" from "the proxy merely let it through," without changing `run-proxy`'s friendly `ALLOW CRED` terminal output.

**Architecture:** One shared function, `accessLog(pathId)` in `src/envoyConfig.ts`, already generates the Envoy log-format string used by every non-`cand` filter chain (`term`, `pass`, `http`, `deny443`, including the github credential-injection chains, which reuse `accessLog('term')`). Appending four Envoy format operators to that one string changes all of them at once, with no branching. `src/runProxy/parseLine.ts` is the sole consumer that turns raw `CFGM|` lines into a structured object; it needs to accept the wider line and expose the new fields, but the value stops there — `classify.ts`/`formatOutput.ts`/`runProxyLoop.ts` (which produce the friendly terminal tags) are untouched and keep building `Entry` from only the fields they already use.

**Tech Stack:** TypeScript, Vitest (`tests/unit/*`, `tests/integration/*`), Envoy access-log format operators (`%RESPONSE_CODE%`, `%RESPONSE_FLAGS%`, `%DURATION%`, `%BYTES_SENT%`).

## Global Constraints

- Never log any part of the `Authorization` header (or any other credential header) for `term`/`pass` paths — those paths inject the real, live Claude/GitHub credential via `envoy.filters.http.credential_injector`, and logging it would leak a production secret into `docker compose logs`. (From the spec's "Rejected: logging auth header info" section.)
- The `#pragma auth candidate` (`cand`) path's access log format (`authCandidateAccessLog()` in `src/envoyConfig.ts`) is out of scope — do not modify it.
- `src/runProxy/classify.ts`, `src/runProxy/formatOutput.ts`, and `src/runProxy/runProxyLoop.ts` are out of scope — the `Entry` type and the printed `HH:MM:SS  TAG  domain` line must not change.
- Use `%BYTES_SENT%` (bytes sent to the downstream/VM — i.e. how much of the response the VM received), not `%BYTES_RECEIVED%` (bytes received from the downstream's request body — irrelevant here).

---

## File Structure

- **Modify `src/envoyConfig.ts`** — `accessLog(pathId)` (currently lines 26–43): extend the `inline_string` format with four more `|`-delimited fields. This is the only production-code file whose *behavior* changes.
- **Modify `src/runProxy/parseLine.ts`** — `AccessLine` interface and `parseLine()`: accept the wider non-`cand` line, parse the four new fields, bump `expectedFields` for non-`cand` lines from `6` to `10`.
- **Modify `tests/unit/envoyConfig.test.ts`** — extend the existing `'tags every path with a CFGM access log to stdout'` test (and the `deny443` fallback test) to assert the new fields are present in the format string for `term`/`pass`/`http`/`deny443`, and add a new assertion that the `cand` format is unchanged.
- **Modify `tests/unit/runProxy/parseLine.test.ts`** — update the existing well-formed-line test to the new 10-field shape, add a test for the new fields, and add a test that an old-shape 6-field line now returns `null` (field count moved).
- **Verify (no code change expected) `tests/integration/proxy.test.ts`** — run it and confirm the existing `CFGM|` prefix/regex assertions (which only check leading fields, not total count) still pass against the real Envoy stack emitting the wider line.

---

## Task 1: Extend the Envoy access log format with response/duration/bytes fields

**Files:**

- Modify: `src/envoyConfig.ts:26-43` (the `accessLog` function)
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: nothing new — `accessLog(pathId: string)` keeps its existing signature and is still called from the same five call sites (`src/envoyConfig.ts:298`, `:391`, `:616`, `:631`, `:649`).
- Produces: the `CFGM|<pathId>|...` log line now carries 10 pipe-delimited fields instead of 6 for every path built by `accessLog()`. Field 7 is the HTTP response code, field 8 is Envoy's response flags, field 9 is duration in ms, field 10 is bytes sent to the client. `src/runProxy/parseLine.ts` (Task 2) is the consumer that will parse these.

- [ ] **Step 1: Write the failing test for the new format string**

Open `tests/unit/envoyConfig.test.ts` and replace the body of the `'tags every path with a CFGM access log to stdout'` test (currently around line 130) with:

```typescript
  it('tags every path with a CFGM access log to stdout, including response/duration/bytes fields', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');

    const expectedSuffix = '|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%\n';

    const termChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );
    const termLog = termChain.filters[0].typed_config.access_log[0];
    expect(termLog.name).toBe('envoy.access_loggers.file');
    expect(termLog.typed_config.path).toBe('/dev/stdout');
    const termFormat = termLog.typed_config.log_format.text_format_source.inline_string;
    expect(termFormat).toMatch(/^CFGM\|term\|/);
    expect(termFormat.endsWith(expectedSuffix)).toBe(true);

    const passChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
    );
    const passTcp = passChain.filters.find(
      (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
    ).typed_config;
    const passFormat = passTcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
    expect(passFormat).toMatch(/^CFGM\|pass\|/);
    expect(passFormat.endsWith(expectedSuffix)).toBe(true);

    const httpFormat =
      listener80.filter_chains[0].filters[0].typed_config.access_log[0].typed_config.log_format
        .text_format_source.inline_string;
    expect(httpFormat).toMatch(/^CFGM\|http\|/);
    expect(httpFormat.endsWith(expectedSuffix)).toBe(true);
  });
```

Then update the `deny443` assertion inside the existing `'adds a default_filter_chain that logs blocked SNI and routes to the blackhole cluster'` test (currently around line 235) — replace:

```typescript
    expect(tcp.access_log[0].typed_config.log_format.text_format_source.inline_string).toMatch(
      /^CFGM\|deny443\|/,
    );
```

with:

```typescript
    const deny443Format = tcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
    expect(deny443Format).toMatch(/^CFGM\|deny443\|/);
    expect(deny443Format.endsWith('|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%\n')).toBe(
      true,
    );
```

Finally, add a new test right after the existing `'logs the five auth headers truncated to 12 chars via a cand access log'` test (currently ending around line 312), inside the same `describe('generateEnvoyConfig auth candidate', ...)` block, to lock in that `cand` is untouched:

```typescript
  it('does not add response/duration/bytes fields to the cand access log', () => {
    const config = generateEnvoyConfig(candAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    const log =
      chain.filters[0].typed_config.access_log[0].typed_config.log_format.text_format_source
        .inline_string;
    expect(log).not.toContain('%RESPONSE_CODE%');
    expect(log).not.toContain('%RESPONSE_FLAGS%');
    expect(log).not.toContain('%DURATION%');
    expect(log).not.toContain('%BYTES_SENT%');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/envoyConfig.test.ts -t "CFGM"`

Expected: the `'tags every path with a CFGM access log to stdout, including response/duration/bytes fields'` and the `deny443` fallback test both FAIL, because `expectedSuffix` / the new suffix check don't match today's format string (which ends in `%RESPONSE_CODE_DETAILS%\n` with no trailing `|%RESPONSE_CODE%|...`). The new `cand`-untouched test should PASS already (nothing to break yet).

- [ ] **Step 3: Extend the format string in `accessLog()`**

In `src/envoyConfig.ts`, replace the `accessLog` function (lines 26-43):

```typescript
function accessLog(pathId: string): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              `CFGM|${pathId}|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|` +
              `%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%\n`,
          },
        },
      },
    },
  ];
}
```

with:

```typescript
function accessLog(pathId: string): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              `CFGM|${pathId}|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|` +
              `%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%RESPONSE_CODE%|%RESPONSE_FLAGS%|` +
              `%DURATION%|%BYTES_SENT%\n`,
          },
        },
      },
    },
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/envoyConfig.test.ts`

Expected: all tests in the file PASS, including the two updated ones and the new `cand`-untouched test.

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(proxy-logs): add response code, flags, duration, bytes-sent to access log"
```

---

## Task 2: Parse the new fields in `parseLine`

**Files:**

- Modify: `src/runProxy/parseLine.ts` (whole file, 41 lines)
- Test: `tests/unit/runProxy/parseLine.test.ts`

**Interfaces:**

- Consumes: the wider `CFGM|` line produced by Task 1's `accessLog()`.
- Produces: `AccessLine` gains four new optional fields — `responseCode?: string`, `responseFlags?: string`, `duration?: string`, `bytesSent?: string` — populated for `term`/`pass`/`http`/`deny443` lines, left `undefined` for `cand` lines (which don't carry them). `classify.ts` is not modified by this task and will continue to read only the fields it already destructures (`pathId`, `time`, `serverName`, `authority`, `codeDetails`, `authHeaders`), so it is unaffected by these additions.

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/runProxy/parseLine.test.ts`. Replace the first test (`'parses a well-formed CFGM line'`, lines 5-14) with the new 10-field shape:

```typescript
  it('parses a well-formed CFGM line', () => {
    const line =
      'CFGM|term|2026-07-06T12:04:31|api.anthropic.com|api.anthropic.com|via_upstream|200|-|842|1531';
    expect(parseLine(line)).toEqual({
      pathId: 'term',
      time: '2026-07-06T12:04:31',
      serverName: 'api.anthropic.com',
      authority: 'api.anthropic.com',
      codeDetails: 'via_upstream',
      responseCode: '200',
      responseFlags: '-',
      duration: '842',
      bytesSent: '1531',
    });
  });
```

Update the `'tolerates a docker compose log prefix before the marker'` test (lines 16-20) to the new field count:

```typescript
  it('tolerates a docker compose log prefix before the marker', () => {
    const line = 'envoy-1  | CFGM|deny443|2026-07-06T12:00:00|blocked.example.com|-|-|-|NR|3|0';
    expect(parseLine(line)?.pathId).toBe('deny443');
    expect(parseLine(line)?.serverName).toBe('blocked.example.com');
    expect(parseLine(line)?.responseFlags).toBe('NR');
  });
```

Update the `'returns null when the field count is wrong'` test (lines 30-32) — it already asserts a too-short line is rejected, so it stays correct as-is with no change needed, but add a second case right after it asserting that the *old* 6-field shape (valid before this change, now missing the four new fields) is also rejected:

```typescript
  it('returns null when the field count is wrong', () => {
    expect(parseLine('CFGM|term|2026-07-06T12:04:31|only-four')).toBeNull();
  });

  it('returns null for the old 6-field non-cand shape (now missing 4 required fields)', () => {
    expect(
      parseLine('CFGM|term|2026-07-06T12:04:31|api.anthropic.com|api.anthropic.com|via_upstream'),
    ).toBeNull();
  });
```

Leave the `cand`-related tests (`'parses an 11-field cand line into authHeaders'`, `'returns null for a cand line without 11 fields'`, `'returns null for a non-cand line with 11 fields'`) unchanged — `cand`'s field count doesn't change in this plan. The last one already sends a non-`cand` line with 11 fields and expects `null`; with the new non-`cand` count now `10`, this line still has the wrong count (11 ≠ 10) so it still correctly returns `null` — no edit needed there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/runProxy/parseLine.test.ts`

Expected: `'parses a well-formed CFGM line'`, `'tolerates a docker compose log prefix before the marker'`, and `'returns null for the old 6-field non-cand shape...'` all FAIL — the current `parseLine` still expects exactly 6 fields for non-`cand` lines, so the new 10-field lines parse the two "well-formed" tests to `null` (mismatch with `toEqual`), and the old 6-field line in the new test still parses successfully instead of returning `null`.

- [ ] **Step 3: Implement the field parsing**

Replace the full contents of `src/runProxy/parseLine.ts`:

```typescript
export type PathId = 'term' | 'pass' | 'http' | 'deny443' | 'cand';

/** Header names carried by a `cand` line, in field order; also their display names. */
export const CAND_HEADER_NAMES = [
  'Authorization',
  'Cookie',
  'X-API-Key',
  'X-Auth-Token',
  'Proxy-Authorization',
] as const;

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
  /** Non-`cand` only: the actual HTTP status Envoy returned to the client. */
  responseCode?: string;
  /** Non-`cand` only: Envoy's short failure codes (e.g. `UF`, `UT`), `-` when none apply. */
  responseFlags?: string;
  /** Non-`cand` only: total request duration in milliseconds. */
  duration?: string;
  /** Non-`cand` only: body bytes Envoy sent to the downstream client. */
  bytesSent?: string;
  /** `cand` only: the five truncated header values in CAND_HEADER_NAMES order ('-' when absent). */
  authHeaders?: string[];
}

const PATH_IDS = new Set<PathId>(['term', 'pass', 'http', 'deny443', 'cand']);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  const pathId = parts[1] as PathId;
  if (!PATH_IDS.has(pathId)) return null;
  const expectedFields = pathId === 'cand' ? 11 : 10;
  if (parts.length !== expectedFields) return null;
  const [, , time, serverName, authority, codeDetails] = parts;
  if (pathId === 'cand') {
    return {
      pathId,
      time,
      serverName,
      authority,
      codeDetails,
      authHeaders: parts.slice(6),
    };
  }
  const [, , , , , , responseCode, responseFlags, duration, bytesSent] = parts;
  return {
    pathId,
    time,
    serverName,
    authority,
    codeDetails,
    responseCode,
    responseFlags,
    duration,
    bytesSent,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/runProxy/parseLine.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Run the full unit suite to confirm `classify`/`formatOutput` are unaffected**

Run: `pnpm vitest run tests/unit/runProxy`

Expected: all tests PASS, including `tests/unit/runProxy/classify.test.ts` — it only reads `pathId`/`serverName`/`authority`/`codeDetails`/`time`/`authHeaders` off the `AccessLine` it receives, so the new optional fields don't affect it.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/parseLine.ts tests/unit/runProxy/parseLine.test.ts
git commit -m "feat(proxy-logs): parse response code, flags, duration, bytes-sent fields"
```

---

## Task 3: Verify the real Envoy stack against the integration suite

**Files:**

- Test: `tests/integration/proxy.test.ts` (no code change expected — this task is a verification gate, not a new test)

**Interfaces:**

- Consumes: the built `envoy.yaml` from Task 1 running in the real (dockerized) Envoy from the existing integration harness.
- Produces: confidence that the wider `CFGM|` line doesn't break the one integration test that currently asserts against it — `tests/integration/proxy.test.ts:284-322`, whose assertions are `toContain('CFGM|...')` / `toMatch(/CFGM\|deny443\|[^|]*\|blocked\.example\.com\|/)` style, i.e. they only anchor on leading fields and don't pin the total field count, so they're expected to keep passing unmodified.

- [ ] **Step 1: Run the integration suite**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/proxy.test.ts`

Expected: all tests PASS, including `'emits a CFGM line for terminate, passthrough, port-80, and blocked SNI'` and the `cand` line test. If any assertion fails because it *does* pin an exact field count or exact trailing content that Task 1 changed, fix that specific assertion in `tests/integration/proxy.test.ts` to match the new 10-field non-`cand` shape (following the same pattern used in Task 1's and Task 2's tests) and re-run.

- [ ] **Step 2: If no changes were needed, confirm and stop here**

If Step 1 passed with no edits, there is nothing to commit for this task — the verification is the deliverable. Note in your working notes (not a commit) that the integration suite was confirmed green against the new format.

- [ ] **Step 2b (only if Step 1 required a fix): commit the fix**

```bash
git add tests/integration/proxy.test.ts
git commit -m "test(proxy-logs): update integration assertion for wider CFGM line"
```

---

## Self-Review

**Spec coverage:**

- `%RESPONSE_CODE%`, `%RESPONSE_FLAGS%`, `%DURATION%`, `%BYTES_SENT%` added to `accessLog()` — Task 1. ✓
- Applies uniformly to `term`/`pass`/`http`/`deny443` (including github chains, which reuse `accessLog('term')` at `src/envoyConfig.ts:298`) via the one shared function — Task 1, no branching added. ✓
- `cand` path left untouched — Task 1 Step 1 adds an explicit test asserting the new operators are absent from the `cand` format. ✓
- `parseLine.ts` updated: new optional fields, `expectedFields` 6→10 for non-`cand` — Task 2. ✓
- `classify.ts`/`formatOutput.ts`/`runProxyLoop.ts` unchanged — Task 2 Step 5 runs the full `tests/unit/runProxy` suite (which includes `classify.test.ts`) to confirm this without editing those files. ✓
- No `Authorization`-header logging added anywhere — no task touches header-logging code; Task 1's diff is reviewable as exactly four new response/timing operators. ✓
- Integration coverage — Task 3 verifies the real Envoy stack still satisfies the existing `CFGM|` assertions under the new format. ✓

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate"-style steps; every step has literal code, exact file paths, and exact commands with expected output.

**Type consistency:** `AccessLine`'s new field names (`responseCode`, `responseFlags`, `duration`, `bytesSent`) are used identically in Task 2's implementation and its tests; Task 1's plan text and Task 2's implementation agree on field order (`RESPONSE_CODE`, `RESPONSE_FLAGS`, `DURATION`, `BYTES_SENT`) and on using `%BYTES_SENT%` (not `%BYTES_RECEIVED%`) throughout.
