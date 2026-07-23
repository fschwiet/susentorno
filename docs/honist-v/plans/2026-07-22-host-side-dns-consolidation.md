# Host-Side DNS Consolidation Implementation Plan

**Goal:** Replace both guests' in-guest fake DNS responders with a single DNS responder and DHCP server running on the Hyper-V host under `run-proxy`, so each guest's entire network configuration becomes "DHCP + trust the proxy CA".

**Architecture:** Two new services live in `src/runProxy/` alongside the existing `gateway.ts`, bound to the Hyper-V Internal-switch adapter IP. The DNS responder answers every A query with that same host IP, so guests connect straight to the proxy with SNI intact and no DNAT is needed. The DHCP server hands out addresses from an in-memory lease table with the host as both router and DNS. Guest-side, the entire DNS/DNAT/route layer is deleted. Pure protocol logic is separated from socket handling throughout so it can be unit-tested as byte arrays.

**Tech Stack:** TypeScript (strict), Node `node:dgram`/`node:net`, vitest, pnpm, PowerShell (host scripts), netplan/systemd (Ubuntu guest), Hyper-V.

**Spec:** `docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`

## Global Constraints

- **Windows host only.** Both services bind a specific Internal-switch adapter IP; this is what lets them coexist with the ICS wildcard `0.0.0.0:53` holder. Do not "simplify" either bind to `0.0.0.0`.
- **UDP only.** No TCP listener for DNS. TCP/53 is out of scope.
- **DNS TTL is 30 seconds.** Matches the responder being replaced.
- **AAAA and every non-A qtype must return NOERROR with zero answer records — never NXDOMAIN.** Callers fall back to A instead of concluding the name does not exist. This is load-bearing.
- **Bind failure is fatal and loud.** A silently-absent listener strands guests. Never degrade quietly.
- **Startup is all-or-nothing.** A failure starting service N closes services 1..N-1 in reverse order.
- **Assert response bytes in tests, never a client cmdlet's interpretation.** `Resolve-DnsName` reports NOERROR-with-zero-answers as "DNS server failure"; that is a reporting artifact, not a defect.
- **Test commands:** `pnpm test:unit` (vitest), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, full gate is `pnpm test`. VM harness is `pnpm test:vm` (not part of `pnpm test`).
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `refactor:`, `docs:`, `test:`).

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/runProxy/ip.ts` | IPv4 string↔integer helpers, shared by DHCP and lease code |
| `src/runProxy/dnsMessage.ts` | DNS query parsing and response building. Pure, no sockets |
| `src/runProxy/dnsResponder.ts` | UDP socket lifecycle for DNS; delegates to `dnsMessage` |
| `src/runProxy/dhcpMessage.ts` | DHCP packet parse/build and option codec. Pure, no sockets |
| `src/runProxy/dhcpLeases.ts` | In-memory lease table: acquire, renew, release, decline, expiry |
| `src/runProxy/dhcpHandler.ts` | RFC 2131 state machine mapping a request to a reply. Pure |
| `src/runProxy/dhcpServer.ts` | UDP socket lifecycle for DHCP; delegates to handler |
| `src/runProxy/serviceStack.ts` | All-or-nothing startup with reverse-order rollback |

**Modified:** `src/runProxy/forwarder.ts` (add netmask resolution), `src/commands/runProxy.ts` (wiring), `templates/proxy/host-allow-vm-inbound.ps1`, `templates/proxy/verify-proxy.ps1`, guest templates, docs.

**Deleted:** `templates/vm-shared/pre-scripts/{dnsmasq-stub.conf,configamatron-egress.service,60-dns-override.yaml}`, `templates/vm-shared-windows/pre-scripts/dns-responder/`.

Why split this finely: `dnsMessage`/`dhcpMessage`/`dhcpLeases`/`dhcpHandler` are all pure functions over bytes and state, which makes them exhaustively unit-testable without sockets. The socket modules stay thin enough to be checked by a handful of integration tests. The spec's Layer-1 test strategy depends on this separation.

---

# PHASE 1 — Host DNS responder

### Task 1: DNS message codec

**Files:**

- Create: `src/runProxy/dnsMessage.ts`
- Test: `tests/unit/runProxy/dnsMessage.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type ParseResult = { kind: 'ok'; query: ParsedQuery } | { kind: 'drop'; reason: string } | { kind: 'formerr'; id: number; reason: string }`
  - `interface ParsedQuery { id: number; rd: boolean; name: string; qtype: number; questionEnd: number }`
  - `function parseQuery(buf: Buffer): ParseResult`
  - `function buildResponse(buf: Buffer, query: ParsedQuery, answerIp: string | null): Buffer`
  - `function buildFormErr(id: number): Buffer`
  - `function answerFor(name: string, qtype: number, hostIp: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dnsMessage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  buildResponse,
  buildFormErr,
  answerFor,
} from '../../../src/runProxy/dnsMessage';

/** Build a DNS query packet for testing. */
function query(
  name: string,
  qtype = 1,
  qclass = 1,
  opts: { id?: number; rd?: boolean; qdcount?: number; qr?: boolean; opcode?: number } = {},
): Buffer {
  const labels = name.split('.').filter(Boolean);
  const nameLen = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const buf = Buffer.alloc(12 + nameLen + 4);
  buf.writeUInt16BE(opts.id ?? 0x1234, 0);
  let flags = 0;
  if (opts.qr) flags |= 0x8000;
  flags |= ((opts.opcode ?? 0) & 0x0f) << 11;
  if (opts.rd ?? true) flags |= 0x0100;
  buf.writeUInt16BE(flags, 2);
  buf.writeUInt16BE(opts.qdcount ?? 1, 4);
  let off = 12;
  for (const l of labels) {
    buf.writeUInt8(l.length, off++);
    buf.write(l, off, 'ascii');
    off += l.length;
  }
  buf.writeUInt8(0, off++);
  buf.writeUInt16BE(qtype, off);
  buf.writeUInt16BE(qclass, off + 2);
  return buf;
}

describe('parseQuery', () => {
  it('parses a well-formed A query', () => {
    const r = parseQuery(query('api.anthropic.com'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.query.name).toBe('api.anthropic.com');
    expect(r.query.qtype).toBe(1);
    expect(r.query.id).toBe(0x1234);
    expect(r.query.rd).toBe(true);
  });

  it('lowercases the name', () => {
    const r = parseQuery(query('API.Anthropic.COM'));
    expect(r.kind === 'ok' && r.query.name).toBe('api.anthropic.com');
  });

  it('drops packets shorter than a 12-byte header', () => {
    expect(parseQuery(Buffer.alloc(11)).kind).toBe('drop');
  });

  it('drops responses (QR=1) so replies cannot loop', () => {
    expect(parseQuery(query('a.test', 1, 1, { qr: true })).kind).toBe('drop');
  });

  it('rejects a non-QUERY opcode with FORMERR', () => {
    expect(parseQuery(query('a.test', 1, 1, { opcode: 2 })).kind).toBe('formerr');
  });

  it('rejects QDCOUNT other than 1 with FORMERR', () => {
    expect(parseQuery(query('a.test', 1, 1, { qdcount: 2 })).kind).toBe('formerr');
  });

  it('rejects a non-IN class with FORMERR', () => {
    expect(parseQuery(query('a.test', 1, 3)).kind).toBe('formerr');
  });

  it('rejects a compression pointer in the question with FORMERR', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt16BE(0x1234, 0);
    buf.writeUInt16BE(0x0100, 2);
    buf.writeUInt16BE(1, 4);
    buf.writeUInt8(0xc0, 12);
    buf.writeUInt8(0x0c, 13);
    expect(parseQuery(buf).kind).toBe('formerr');
  });

  it('rejects a label running past the end of the buffer', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt16BE(0x1234, 0);
    buf.writeUInt16BE(0x0100, 2);
    buf.writeUInt16BE(1, 4);
    buf.writeUInt8(60, 12);
    expect(parseQuery(buf).kind).toBe('formerr');
  });
});

describe('answerFor', () => {
  it('answers A with the host IP', () => {
    expect(answerFor('anything.test', 1, '192.168.67.1')).toBe('192.168.67.1');
  });

  it('returns null for AAAA so the response carries no answer records', () => {
    expect(answerFor('anything.test', 28, '192.168.67.1')).toBeNull();
  });

  it('returns null for other qtypes', () => {
    for (const qtype of [2, 5, 15, 16, 33]) {
      expect(answerFor('anything.test', qtype, '192.168.67.1')).toBeNull();
    }
  });
});

describe('buildResponse', () => {
  it('answers an A query with the host IP, TTL 30', () => {
    const q = query('api.anthropic.com');
    const parsed = parseQuery(q);
    if (parsed.kind !== 'ok') throw new Error('setup');
    const r = buildResponse(q, parsed.query, '192.168.67.1');

    expect(r.readUInt16BE(0)).toBe(0x1234); // id echoed
    expect(r.readUInt16BE(2) & 0x8000).toBe(0x8000); // QR=1
    expect(r.readUInt16BE(2) & 0x0100).toBe(0x0100); // RD preserved
    expect(r.readUInt16BE(2) & 0x0080).toBe(0); // RA=0
    expect(r.readUInt16BE(2) & 0x000f).toBe(0); // RCODE=0
    expect(r.readUInt16BE(4)).toBe(1); // QDCOUNT
    expect(r.readUInt16BE(6)).toBe(1); // ANCOUNT
    expect(r.readUInt16BE(8)).toBe(0); // NSCOUNT
    expect(r.readUInt16BE(10)).toBe(0); // ARCOUNT

    const ansOff = parsed.query.questionEnd;
    expect(r.readUInt16BE(ansOff)).toBe(0xc00c); // compression pointer
    expect(r.readUInt16BE(ansOff + 2)).toBe(1); // TYPE A
    expect(r.readUInt16BE(ansOff + 4)).toBe(1); // CLASS IN
    expect(r.readUInt32BE(ansOff + 6)).toBe(30); // TTL
    expect(r.readUInt16BE(ansOff + 10)).toBe(4); // RDLENGTH
    expect([...r.subarray(ansOff + 12, ansOff + 16)]).toEqual([192, 168, 67, 1]);
  });

  it('clears RD when the query did not set it', () => {
    const q = query('a.test', 1, 1, { rd: false });
    const parsed = parseQuery(q);
    if (parsed.kind !== 'ok') throw new Error('setup');
    const r = buildResponse(q, parsed.query, '192.168.67.1');
    expect(r.readUInt16BE(2) & 0x0100).toBe(0);
  });

  it('returns NOERROR with zero answers when there is no answer IP', () => {
    const q = query('a.test', 28);
    const parsed = parseQuery(q);
    if (parsed.kind !== 'ok') throw new Error('setup');
    const r = buildResponse(q, parsed.query, null);
    expect(r.readUInt16BE(6)).toBe(0); // ANCOUNT
    expect(r.readUInt16BE(2) & 0x000f).toBe(0); // RCODE=0, NOT NXDOMAIN
    expect(r.length).toBe(parsed.query.questionEnd); // header + question only
  });

  it('echoes the question section byte for byte', () => {
    const q = query('api.anthropic.com');
    const parsed = parseQuery(q);
    if (parsed.kind !== 'ok') throw new Error('setup');
    const r = buildResponse(q, parsed.query, '192.168.67.1');
    expect(r.subarray(12, parsed.query.questionEnd)).toEqual(
      q.subarray(12, parsed.query.questionEnd),
    );
  });
});

describe('buildFormErr', () => {
  it('sets RCODE=1 with all counts zero and does not echo request counts', () => {
    const r = buildFormErr(0xbeef);
    expect(r.length).toBe(12);
    expect(r.readUInt16BE(0)).toBe(0xbeef);
    expect(r.readUInt16BE(2) & 0x8000).toBe(0x8000);
    expect(r.readUInt16BE(2) & 0x000f).toBe(1);
    expect(r.readUInt16BE(4)).toBe(0);
    expect(r.readUInt16BE(6)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dnsMessage.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/runProxy/dnsMessage"`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dnsMessage.ts`:

```ts
/**
 * DNS query parsing and response building for the host-side catch-all responder.
 *
 * Deliberately NOT a verbatim port of the in-guest ConfigamatronDnsResponder: that
 * one binds 127.0.0.1 and only ever hears a local stub resolver, whereas this binds
 * a network-facing address every guest on the switch can reach. The accepted query
 * grammar is therefore narrow, and anything outside it is rejected rather than
 * best-effort parsed.
 */

const HEADER_LEN = 12;
const TTL_SECONDS = 30;
const QTYPE_A = 1;
const QCLASS_IN = 1;
const MAX_NAME_LEN = 255;
const MAX_LABEL_LEN = 63;

export interface ParsedQuery {
  id: number;
  /** Recursion Desired, echoed back so clients see their own flag. */
  rd: boolean;
  /** Lowercased dotted name, e.g. "api.anthropic.com". */
  name: string;
  qtype: number;
  /** Byte offset just past the question section (header + qname + qtype + qclass). */
  questionEnd: number;
}

export type ParseResult =
  | { kind: 'ok'; query: ParsedQuery }
  | { kind: 'drop'; reason: string }
  | { kind: 'formerr'; id: number; reason: string };

export function parseQuery(buf: Buffer): ParseResult {
  // Too short to hold even a transaction ID, so no reply is possible.
  if (buf.length < HEADER_LEN) return { kind: 'drop', reason: 'short header' };

  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);

  // QR=1 means this is a response. Answering it could bounce between responders.
  if ((flags & 0x8000) !== 0) return { kind: 'drop', reason: 'QR set' };

  const opcode = (flags >> 11) & 0x0f;
  if (opcode !== 0) return { kind: 'formerr', id, reason: `opcode ${opcode}` };

  const qdcount = buf.readUInt16BE(4);
  if (qdcount !== 1) return { kind: 'formerr', id, reason: `qdcount ${qdcount}` };

  const labels: string[] = [];
  let off = HEADER_LEN;
  let nameLen = 0;
  for (;;) {
    if (off >= buf.length) return { kind: 'formerr', id, reason: 'name past end' };
    const len = buf.readUInt8(off);
    if (len === 0) {
      off += 1;
      break;
    }
    // A question section has nothing earlier to point back at, so a pointer here is malformed.
    if ((len & 0xc0) !== 0) return { kind: 'formerr', id, reason: 'compression pointer' };
    if (len > MAX_LABEL_LEN) return { kind: 'formerr', id, reason: 'label too long' };
    if (off + 1 + len > buf.length) return { kind: 'formerr', id, reason: 'label past end' };
    labels.push(buf.toString('ascii', off + 1, off + 1 + len));
    nameLen += len + 1;
    if (nameLen > MAX_NAME_LEN) return { kind: 'formerr', id, reason: 'name too long' };
    off += 1 + len;
  }

  if (off + 4 > buf.length) return { kind: 'formerr', id, reason: 'question truncated' };
  const qtype = buf.readUInt16BE(off);
  const qclass = buf.readUInt16BE(off + 2);
  if (qclass !== QCLASS_IN) return { kind: 'formerr', id, reason: `qclass ${qclass}` };

  return {
    kind: 'ok',
    query: {
      id,
      rd: (flags & 0x0100) !== 0,
      name: labels.join('.').toLowerCase(),
      qtype,
      questionEnd: off + 4,
    },
  };
}

/**
 * The answer policy, kept separate from packet construction so it can be changed
 * (e.g. for host-served names) without touching wire-format code. Today it ignores
 * the name entirely.
 *
 * Returning null for every non-A qtype is deliberate: the caller emits NOERROR with
 * zero answers rather than NXDOMAIN, so an AAAA lookup falls back to A instead of
 * concluding the name does not exist.
 */
export function answerFor(_name: string, qtype: number, hostIp: string): string | null {
  return qtype === QTYPE_A ? hostIp : null;
}

export function buildResponse(
  request: Buffer,
  query: ParsedQuery,
  answerIp: string | null,
): Buffer {
  const questionLen = query.questionEnd - HEADER_LEN;
  const answerLen = answerIp ? 16 : 0;
  const out = Buffer.alloc(HEADER_LEN + questionLen + answerLen);

  out.writeUInt16BE(query.id, 0);
  out.writeUInt16BE(0x8000 | (query.rd ? 0x0100 : 0), 2); // QR=1, RD preserved, RA=0, RCODE=0
  out.writeUInt16BE(1, 4); // QDCOUNT
  out.writeUInt16BE(answerIp ? 1 : 0, 6); // ANCOUNT
  out.writeUInt16BE(0, 8); // NSCOUNT
  out.writeUInt16BE(0, 10); // ARCOUNT

  request.copy(out, HEADER_LEN, HEADER_LEN, query.questionEnd);

  if (answerIp) {
    let off = query.questionEnd;
    out.writeUInt16BE(0xc00c, off); // NAME: pointer to the question's name at offset 12
    out.writeUInt16BE(QTYPE_A, off + 2);
    out.writeUInt16BE(QCLASS_IN, off + 4);
    out.writeUInt32BE(TTL_SECONDS, off + 6);
    out.writeUInt16BE(4, off + 10);
    off += 12;
    for (const octet of answerIp.split('.')) out.writeUInt8(Number(octet), off++);
  }

  return out;
}

/**
 * Header-only FORMERR. Counts are written explicitly rather than echoed from the
 * request, so a hostile packet claiming ANCOUNT=5 cannot have that reflected back.
 */
export function buildFormErr(id: number): Buffer {
  const out = Buffer.alloc(HEADER_LEN);
  out.writeUInt16BE(id, 0);
  out.writeUInt16BE(0x8001, 2); // QR=1, RCODE=1 (FORMERR)
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dnsMessage.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dnsMessage.ts tests/unit/runProxy/dnsMessage.test.ts
git commit -m "feat: add DNS message codec for the host-side responder"
```

---

### Task 2: DNS responder socket

**Files:**

- Create: `src/runProxy/dnsResponder.ts`
- Test: `tests/unit/runProxy/dnsResponder.test.ts`

**Interfaces:**

- Consumes: `parseQuery`, `buildResponse`, `buildFormErr`, `answerFor` from `src/runProxy/dnsMessage`.
- Produces:
  - `interface DnsResponderOptions { listenAddress: string; answerIp: string; port?: number; onError?: (message: string) => void }`
  - `interface DnsResponderHandle { readonly port: number; close(): Promise<void> }`
  - `function startDnsResponder(opts: DnsResponderOptions): Promise<DnsResponderHandle>`

Tests bind `127.0.0.1` on an ephemeral port — never `:53`, which is held by ICS on a real host.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dnsResponder.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { startDnsResponder, type DnsResponderHandle } from '../../../src/runProxy/dnsResponder';

let handle: DnsResponderHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

function query(name: string, qtype = 1, id = 0x4242): Buffer {
  const labels = name.split('.');
  const nameLen = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const buf = Buffer.alloc(12 + nameLen + 4);
  buf.writeUInt16BE(id, 0);
  buf.writeUInt16BE(0x0100, 2);
  buf.writeUInt16BE(1, 4);
  let off = 12;
  for (const l of labels) {
    buf.writeUInt8(l.length, off++);
    buf.write(l, off, 'ascii');
    off += l.length;
  }
  buf.writeUInt8(0, off++);
  buf.writeUInt16BE(qtype, off);
  buf.writeUInt16BE(1, off + 2);
  return buf;
}

/** Send one query and resolve with the reply, or reject on timeout. */
function ask(port: number, packet: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('timeout'));
    }, 2000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(packet, port, '127.0.0.1');
  });
}

describe('startDnsResponder', () => {
  it('answers an A query with the configured IP', async () => {
    handle = await startDnsResponder({
      listenAddress: '127.0.0.1',
      answerIp: '192.168.67.1',
      port: 0,
    });
    const reply = await ask(handle.port, query('api.anthropic.com'));
    expect(reply.readUInt16BE(0)).toBe(0x4242);
    expect(reply.readUInt16BE(6)).toBe(1);
    expect([...reply.subarray(reply.length - 4)]).toEqual([192, 168, 67, 1]);
  });

  it('answers AAAA with NOERROR and no answer records', async () => {
    handle = await startDnsResponder({
      listenAddress: '127.0.0.1',
      answerIp: '192.168.67.1',
      port: 0,
    });
    const reply = await ask(handle.port, query('api.anthropic.com', 28));
    expect(reply.readUInt16BE(6)).toBe(0);
    expect(reply.readUInt16BE(2) & 0x000f).toBe(0);
  });

  it('rejects a bind to an address the host does not own', async () => {
    await expect(
      startDnsResponder({ listenAddress: '203.0.113.9', answerIp: '203.0.113.9', port: 0 }),
    ).rejects.toThrow();
  });

  it('close() releases the port', async () => {
    const h = await startDnsResponder({
      listenAddress: '127.0.0.1',
      answerIp: '192.168.67.1',
      port: 0,
    });
    const port = h.port;
    await h.close();
    const again = await startDnsResponder({
      listenAddress: '127.0.0.1',
      answerIp: '192.168.67.1',
      port,
    });
    expect(again.port).toBe(port);
    await again.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dnsResponder.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/dnsResponder`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dnsResponder.ts`:

```ts
import dgram from 'node:dgram';
import { parseQuery, buildResponse, buildFormErr, answerFor } from './dnsMessage';

export interface DnsResponderOptions {
  /** Specific address to bind. Never 0.0.0.0: a specific bind is what lets this
   *  coexist with the ICS wildcard :53 holder, and is also what scopes the
   *  responder to the network it owns. */
  listenAddress: string;
  /** Address returned for every A query. In production this equals listenAddress. */
  answerIp: string;
  /** Defaults to 53. Tests pass 0 for an ephemeral port. */
  port?: number;
  onError?: (message: string) => void;
}

export interface DnsResponderHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function startDnsResponder(opts: DnsResponderOptions): Promise<DnsResponderHandle> {
  const port = opts.port ?? 53;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });

  socket.on('message', (msg, rinfo) => {
    const parsed = parseQuery(msg);
    if (parsed.kind === 'drop') return;

    const reply =
      parsed.kind === 'formerr'
        ? buildFormErr(parsed.id)
        : buildResponse(msg, parsed.query, answerFor(parsed.query.name, parsed.query.qtype, opts.answerIp));

    socket.send(reply, rinfo.port, rinfo.address, (err) => {
      // The client may already be gone; that is not an error worth surfacing.
      if (err) opts.onError?.(`dns: send to ${rinfo.address}:${rinfo.port} failed: ${err.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, opts.listenAddress, () => {
      socket.removeListener('error', reject);
      socket.on('error', (err) => opts.onError?.(`dns: ${err.message}`));
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((r) => socket.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dnsResponder.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dnsResponder.ts tests/unit/runProxy/dnsResponder.test.ts
git commit -m "feat: add host-side DNS responder socket"
```

---

### Task 3: All-or-nothing service startup

**Files:**

- Create: `src/runProxy/serviceStack.ts`
- Test: `tests/unit/runProxy/serviceStack.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface Closable { close(): Promise<void> }`
  - `interface ServiceStack { add<T extends Closable>(start: () => Promise<T>): Promise<T>; closeAll(): Promise<void> }`
  - `function createServiceStack(): ServiceStack`

`gateway.ts:87-90` already rolls back its own listeners, but that guarantee does not span services. Without this, a DHCP bind failure leaves the gateway and DNS responder holding ports and the command exiting.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/serviceStack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createServiceStack, type Closable } from '../../../src/runProxy/serviceStack';

function fake(name: string, log: string[]): Closable {
  return {
    close: async () => {
      log.push(name);
    },
  };
}

describe('createServiceStack', () => {
  it('returns each started service', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    const a = await stack.add(async () => fake('a', log));
    expect(a).toBeDefined();
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });

  it('closes in reverse order on closeAll', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => fake('b', log));
    await stack.add(async () => fake('c', log));
    await stack.closeAll();
    expect(log).toEqual(['c', 'b', 'a']);
  });

  it('rolls back already-started services when one fails to start', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => fake('b', log));
    await expect(
      stack.add(async () => {
        throw new Error('bind EADDRINUSE');
      }),
    ).rejects.toThrow('bind EADDRINUSE');
    expect(log).toEqual(['b', 'a']);
  });

  it('closeAll is idempotent so a rollback followed by shutdown does not double-close', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.closeAll();
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });

  it('keeps closing the rest when one close throws', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => ({
      close: async () => {
        throw new Error('close failed');
      },
    }));
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/serviceStack.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/serviceStack`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/serviceStack.ts`:

```ts
export interface Closable {
  close(): Promise<void>;
}

export interface ServiceStack {
  /**
   * Start a service and take ownership of it. If `start` throws, everything already
   * started is closed in reverse order before the error propagates, so a failed
   * launch never leaves orphaned listeners holding ports.
   */
  add<T extends Closable>(start: () => Promise<T>): Promise<T>;
  /** Close everything in reverse order. Safe to call more than once. */
  closeAll(): Promise<void>;
}

export function createServiceStack(): ServiceStack {
  const started: Closable[] = [];

  const closeAll = async (): Promise<void> => {
    while (started.length > 0) {
      const service = started.pop();
      // One service failing to close must not strand the others.
      try {
        await service?.close();
      } catch {
        /* ignore */
      }
    }
  };

  return {
    add: async <T extends Closable>(start: () => Promise<T>): Promise<T> => {
      let service: T;
      try {
        service = await start();
      } catch (err) {
        await closeAll();
        throw err;
      }
      started.push(service);
      return service;
    },
    closeAll,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/serviceStack.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/serviceStack.ts tests/unit/runProxy/serviceStack.test.ts
git commit -m "feat: add all-or-nothing service startup with reverse-order rollback"
```

---

### Task 4: Wire the DNS responder into `run-proxy`

**Files:**

- Modify: `src/commands/runProxy.ts:135-149` (gateway startup) and `:244-246` (shutdown)
- Test: manual, plus the existing suite must stay green

**Interfaces:**

- Consumes: `startDnsResponder` (Task 2), `createServiceStack` (Task 3), `resolveForwardListenAddress` from `src/runProxy/forwarder`.
- Produces: no new exports.

- [ ] **Step 1: Add the imports**

In `src/commands/runProxy.ts`, alongside the existing `import { resolveForwardListenAddress } from '../runProxy/forwarder';`:

```ts
import { startDnsResponder } from '../runProxy/dnsResponder';
import { createServiceStack } from '../runProxy/serviceStack';
```

- [ ] **Step 2: Replace the gateway startup block**

Replace lines 135-149 (from `let gateway: GatewayHandle;` through the `console.log` of the gateway listen line) with:

```ts
      const services = createServiceStack();
      let gateway: GatewayHandle;
      try {
        gateway = await services.add(() =>
          startGateway({
            listenAddresses,
            httpsListenPort: httpsPort,
            httpListenPort: httpPort,
          }),
        );
      } catch (err) {
        console.error(`run-proxy: failed to start the gateway forwarder: ${String(err)}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `run-proxy: gateway listening on ${listenAddresses.join(', ')} :${httpPort}/${httpsPort}`,
      );

      // DNS is served only when forwarding is on: both mean "serve the Internal
      // switch". A guest on that switch has no other resolver, so a bind failure
      // here is fatal rather than a degraded mode.
      if (options.forward) {
        const dnsIp = listenAddresses[listenAddresses.length - 1];
        try {
          await services.add(() =>
            startDnsResponder({
              listenAddress: dnsIp,
              answerIp: dnsIp,
              onError: (message) => console.error(`run-proxy: ${message}`),
            }),
          );
        } catch (err) {
          console.error(
            `run-proxy: failed to bind DNS on ${dnsIp}:53 — ${String(err)}. ` +
              'Another process may hold that specific address; a wildcard 0.0.0.0:53 holder ' +
              '(e.g. the ICS service) is expected and does not conflict.',
          );
          process.exitCode = 1;
          return;
        }
        console.log(`run-proxy: DNS responder listening on ${dnsIp}:53 (all A -> ${dnsIp})`);
      }
```

- [ ] **Step 3: Replace the shutdown block**

Replace `await gateway.close();` at line 245 with:

```ts
        await services.closeAll();
```

- [ ] **Step 4: Verify types and the existing suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS, no new failures.

- [ ] **Step 5: Verify manually on the host**

Run in one terminal: `pnpm cli run-proxy`
Expected output includes both lines:

```
run-proxy: gateway listening on 127.0.0.1, 192.168.67.1 :80/443
run-proxy: DNS responder listening on 192.168.67.1:53 (all A -> 192.168.67.1)
```

In a second terminal:

```powershell
Get-NetUDPEndpoint -LocalPort 53 | Select-Object LocalAddress,LocalPort,OwningProcess
Resolve-DnsName -Name totally-made-up.invalid -Server 192.168.67.1 -Type A -DnsOnly -NoHostsFile
```

Expected: both `192.168.67.1:53` (node) and `0.0.0.0:53` (ICS `svchost`) present, and the query answers `192.168.67.1`. Then Ctrl+C `run-proxy` and confirm `Get-NetUDPEndpoint -LocalPort 53` shows only the ICS entry.

- [ ] **Step 6: Commit**

```bash
git add src/commands/runProxy.ts
git commit -m "feat: serve DNS from run-proxy on the Internal-switch adapter"
```

---

### Task 5: Firewall rule and verify check for DNS

**Files:**

- Modify: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `templates/proxy/verify-proxy.ps1:165-174`
- Modify: `tests/unit/templates.test.ts` (if it asserts on these scripts — check first)

**Interfaces:**

- Consumes: nothing.
- Produces: firewall rule named `Envoy Sandbox Proxy DNS stub (VM inbound)`.

The Internal-switch adapter is categorized **Public** with `DefaultInboundAction` resolving to block, so without this rule guest DNS is silently dropped. Note this re-adds a rule that `docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md:62` deliberately removed — same name, now current again rather than stale.

- [ ] **Step 1: Rewrite the header comment**

In `templates/proxy/host-allow-vm-inbound.ps1`, replace lines 2-17 (the `<# ... #>` block) with:

```powershell
<#
Opens inbound traffic from the VM's Hyper-V Internal-switch adapter:

  TCP 80/443  - Envoy, via run-proxy's gateway
  UDP 53      - run-proxy's DNS responder

and prints the host IP to pass to the guest setup scripts.

The Internal-switch adapter is categorized Public and inbound defaults to block,
so these rules are required, not optional. Scoped by -InterfaceAlias rather than
a hardcoded subnet CIDR, since the Internal switch's subnet is assigned
per-machine (e.g. 192.168.67.0/24 on one machine, something else on another) -
this keeps working whatever that subnet turns out to be.

DNS answering moved back to the host (see
docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md), so the
UDP/53 rule that an earlier revision of this script removed is current again.

Safe to re-run: replaces any existing rules with the same names.
#>
```

- [ ] **Step 2: Replace the rule creation**

Replace lines 32-39 (from `$tcpRuleName = ...` through the `New-NetFirewallRule` call) with:

```powershell
$tcpRuleName = "Envoy Sandbox Proxy (VM inbound)"
$dnsRuleName = "Envoy Sandbox Proxy DNS stub (VM inbound)"

Get-NetFirewallRule -DisplayName $tcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $dnsRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null
```

- [ ] **Step 3: Add the verify check**

In `templates/proxy/verify-proxy.ps1`, after the existing firewall-rule check at line 169, insert:

```powershell
$dnsRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DNS stub (VM inbound)' -ErrorAction SilentlyContinue
if ($dnsRule) { Add-Pass 'Internal-switch inbound DNS firewall rule present' }
else { Add-Warn 'Internal-switch inbound DNS firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }
```

Then, after the `$hostIp` block at line 174, insert:

```powershell
if ($hostIp) {
    $dnsListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 53 -ErrorAction SilentlyContinue
    if ($dnsListener) { Add-Pass "DNS responder listening on ${hostIp}:53" }
    else { Add-Fail "DNS responder listening on ${hostIp}:53" "not found -- is run-proxy running? guests have no other resolver" }
}
```

- [ ] **Step 4: Check whether the template tests assert on these files**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS. If it fails because it asserts on the old script text, update the assertion to match the new rule set — do not delete the assertion.

- [ ] **Step 5: Verify manually on the host**

Elevated PowerShell, from the environment directory:

```powershell
.\.configamatron\proxy\host-allow-vm-inbound.ps1
Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy*' | Select-Object DisplayName,Enabled
```

Expected: both rules listed and enabled. Then with `run-proxy` running: `.\.configamatron\proxy\verify-proxy.ps1` — expect PASS for both the DNS rule and the `:53` listener.

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/host-allow-vm-inbound.ps1 templates/proxy/verify-proxy.ps1 tests/unit/templates.test.ts
git commit -m "feat: open inbound UDP/53 and verify the host DNS listener"
```

---

# PHASE 2 — Host DHCP server

### Task 6: IPv4 helpers

**Files:**

- Create: `src/runProxy/ip.ts`
- Test: `tests/unit/runProxy/ip.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `function ipToInt(ip: string): number`
  - `function intToIp(value: number): string`
  - `function networkAddress(ip: string, netmask: string): number`
  - `function prefixLength(netmask: string): number`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/ip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ipToInt, intToIp, networkAddress, prefixLength } from '../../../src/runProxy/ip';

describe('ipToInt / intToIp', () => {
  it('round-trips ordinary addresses', () => {
    for (const ip of ['0.0.0.0', '192.168.67.1', '10.0.0.255', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });

  it('treats addresses above 2^31 as unsigned', () => {
    expect(ipToInt('255.255.255.255')).toBe(4294967295);
    expect(intToIp(4294967295)).toBe('255.255.255.255');
  });
});

describe('networkAddress', () => {
  it('masks the host bits for a /24', () => {
    expect(intToIp(networkAddress('192.168.67.1', '255.255.255.0'))).toBe('192.168.67.0');
  });

  it('masks the host bits for a /20', () => {
    expect(intToIp(networkAddress('172.17.224.36', '255.255.240.0'))).toBe('172.17.224.0');
  });
});

describe('prefixLength', () => {
  it('counts mask bits', () => {
    expect(prefixLength('255.255.255.0')).toBe(24);
    expect(prefixLength('255.255.240.0')).toBe(20);
    expect(prefixLength('255.0.0.0')).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/ip.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/ip`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/ip.ts`:

```ts
/** IPv4 helpers shared by the DHCP server and its lease table. */

export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  );
}

export function intToIp(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

export function networkAddress(ip: string, netmask: string): number {
  return (ipToInt(ip) & ipToInt(netmask)) >>> 0;
}

export function prefixLength(netmask: string): number {
  let bits = 0;
  let mask = ipToInt(netmask);
  while (mask & 0x80000000) {
    bits++;
    mask = (mask << 1) >>> 0;
  }
  return bits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/ip.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/ip.ts tests/unit/runProxy/ip.test.ts
git commit -m "feat: add IPv4 helpers for the DHCP server"
```

---

### Task 7: Lease table

**Files:**

- Create: `src/runProxy/dhcpLeases.ts`
- Test: `tests/unit/runProxy/dhcpLeases.test.ts`

**Interfaces:**

- Consumes: `ipToInt`, `intToIp`, `networkAddress` from `src/runProxy/ip`.
- Produces:
  - `interface LeaseTableOptions { hostIp: string; netmask: string; poolStart?: number; poolEnd?: number; leaseSeconds: number; now?: () => number }`
  - `interface LeaseTable { acquire(identity: string): string | null; request(identity: string, requested: string): 'ack' | 'nak'; release(identity: string): void; decline(address: string): void }`
  - `function createLeaseTable(opts: LeaseTableOptions): LeaseTable`

An earlier draft of the spec specified a *stateless* MAC-hash allocator. That was incoherent — probing for a free slot requires knowing what is taken. The hash survives only as a **preferred** address so a guest usually lands on the same IP; the table is authoritative.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dhcpLeases.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createLeaseTable, type LeaseTable } from '../../../src/runProxy/dhcpLeases';

function table(overrides: Partial<Parameters<typeof createLeaseTable>[0]> = {}): LeaseTable {
  return createLeaseTable({
    hostIp: '192.168.67.1',
    netmask: '255.255.255.0',
    leaseSeconds: 3600,
    ...overrides,
  });
}

describe('acquire', () => {
  it('hands out an address inside the pool', () => {
    const ip = table().acquire('aa:bb:cc:dd:ee:ff');
    expect(ip).toMatch(/^192\.168\.67\.\d+$/);
    const last = Number(ip!.split('.')[3]);
    expect(last).toBeGreaterThanOrEqual(10);
    expect(last).toBeLessThanOrEqual(209);
  });

  it('never hands out the host address', () => {
    const t = table();
    for (let i = 0; i < 50; i++) expect(t.acquire(`id-${i}`)).not.toBe('192.168.67.1');
  });

  it('is stable: the same identity gets the same address across tables', () => {
    expect(table().acquire('aa:bb:cc:dd:ee:ff')).toBe(table().acquire('aa:bb:cc:dd:ee:ff'));
  });

  it('returns the existing lease on repeat calls', () => {
    const t = table();
    expect(t.acquire('same')).toBe(t.acquire('same'));
  });

  it('gives colliding identities different addresses', () => {
    const t = table({ poolStart: 10, poolEnd: 11 });
    const a = t.acquire('first');
    const b = t.acquire('second');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('returns null when the pool is exhausted', () => {
    const t = table({ poolStart: 10, poolEnd: 11 });
    t.acquire('a');
    t.acquire('b');
    expect(t.acquire('c')).toBeNull();
  });

  it('reuses an address once its lease expires', () => {
    let clock = 1000;
    const t = createLeaseTable({
      hostIp: '192.168.67.1',
      netmask: '255.255.255.0',
      leaseSeconds: 60,
      poolStart: 10,
      poolEnd: 10,
      now: () => clock,
    });
    expect(t.acquire('a')).toBe('192.168.67.10');
    expect(t.acquire('b')).toBeNull();
    clock += 61_000;
    expect(t.acquire('b')).toBe('192.168.67.10');
  });
});

describe('request', () => {
  it('ACKs an in-range address the client already holds', () => {
    const t = table();
    const ip = t.acquire('client')!;
    expect(t.request('client', ip)).toBe('ack');
  });

  it('ACKs an unknown in-range address, adopting the claim after a restart', () => {
    // Models run-proxy restarting with an empty table while a guest still holds a lease.
    expect(table().request('client', '192.168.67.55')).toBe('ack');
  });

  it('NAKs an address outside the pool', () => {
    expect(table().request('client', '10.9.9.9')).toBe('nak');
  });

  it('NAKs the host address', () => {
    expect(table().request('client', '192.168.67.1')).toBe('nak');
  });

  it('NAKs an address held by someone else', () => {
    const t = table();
    const ip = t.acquire('owner')!;
    expect(t.request('intruder', ip)).toBe('nak');
  });
});

describe('release and decline', () => {
  it('release frees the address for another client', () => {
    const t = table({ poolStart: 10, poolEnd: 10 });
    expect(t.acquire('a')).toBe('192.168.67.10');
    t.release('a');
    expect(t.acquire('b')).toBe('192.168.67.10');
  });

  it('decline takes the address out of service', () => {
    const t = table({ poolStart: 10, poolEnd: 11 });
    const ip = t.acquire('a')!;
    t.release('a');
    t.decline(ip);
    const next = t.acquire('b');
    expect(next).not.toBe(ip);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dhcpLeases.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/dhcpLeases`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dhcpLeases.ts`:

```ts
import { intToIp, ipToInt, networkAddress } from './ip';

export interface LeaseTableOptions {
  hostIp: string;
  netmask: string;
  /** Host-part offset of the first poolable address. Default 10. */
  poolStart?: number;
  /** Host-part offset of the last poolable address. Default 209. */
  poolEnd?: number;
  leaseSeconds: number;
  now?: () => number;
}

export interface LeaseTable {
  /** Existing lease if any, else a fresh one. Null when the pool is full. */
  acquire(identity: string): string | null;
  /** Adjudicate a client's REQUEST for a specific address. */
  request(identity: string, requested: string): 'ack' | 'nak';
  release(identity: string): void;
  decline(address: string): void;
}

interface Lease {
  identity: string;
  expiresAt: number;
}

/** FNV-1a. Only needs to spread identities across the pool, not resist attack. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createLeaseTable(opts: LeaseTableOptions): LeaseTable {
  const poolStart = opts.poolStart ?? 10;
  const poolEnd = opts.poolEnd ?? 209;
  const size = poolEnd - poolStart + 1;
  const base = networkAddress(opts.hostIp, opts.netmask);
  const hostInt = ipToInt(opts.hostIp);
  const now = opts.now ?? Date.now;

  /** address int -> lease */
  const leases = new Map<number, Lease>();
  const declined = new Set<number>();

  const addressAt = (slot: number): number => (base + poolStart + slot) >>> 0;

  const isFree = (addr: number): boolean => {
    if (addr === hostInt || declined.has(addr)) return false;
    const lease = leases.get(addr);
    return !lease || lease.expiresAt <= now();
  };

  const heldBy = (addr: number): string | null => {
    const lease = leases.get(addr);
    if (!lease || lease.expiresAt <= now()) return null;
    return lease.identity;
  };

  const assign = (addr: number, identity: string): void => {
    leases.set(addr, { identity, expiresAt: now() + opts.leaseSeconds * 1000 });
  };

  const findExisting = (identity: string): number | null => {
    for (const [addr, lease] of leases) {
      if (lease.identity === identity && lease.expiresAt > now()) return addr;
    }
    return null;
  };

  return {
    acquire(identity: string): string | null {
      const existing = findExisting(identity);
      if (existing !== null) {
        assign(existing, identity); // renew in place
        return intToIp(existing);
      }

      // Preferred slot from the identity hash, so a given guest normally lands on
      // the same address. This is a hint only - the table resolves conflicts.
      const preferred = hash32(identity) % size;
      for (let i = 0; i < size; i++) {
        const addr = addressAt((preferred + i) % size);
        if (isFree(addr)) {
          assign(addr, identity);
          return intToIp(addr);
        }
      }
      return null; // pool exhausted - caller must log this loudly
    },

    request(identity: string, requested: string): 'ack' | 'nak' {
      const addr = ipToInt(requested);
      const first = addressAt(0);
      const last = addressAt(size - 1);
      if (addr < first || addr > last) return 'nak';
      if (addr === hostInt || declined.has(addr)) return 'nak';

      const owner = heldBy(addr);
      // No owner means either a genuinely free address or one whose lease we lost
      // across a restart. Adopting the client's claim keeps a restart invisible.
      if (owner !== null && owner !== identity) return 'nak';

      assign(addr, identity);
      return 'ack';
    },

    release(identity: string): void {
      const addr = findExisting(identity);
      if (addr !== null) leases.delete(addr);
    },

    decline(address: string): void {
      const addr = ipToInt(address);
      declined.add(addr);
      leases.delete(addr);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dhcpLeases.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dhcpLeases.ts tests/unit/runProxy/dhcpLeases.test.ts
git commit -m "feat: add DHCP lease table with preferred-address hashing"
```

---

### Task 8: DHCP message codec

**Files:**

- Create: `src/runProxy/dhcpMessage.ts`
- Test: `tests/unit/runProxy/dhcpMessage.test.ts`

**Interfaces:**

- Consumes: `ipToInt`, `intToIp` from `src/runProxy/ip`.
- Produces:
  - `const DHCP = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 } as const`
  - `interface DhcpPacket { op: number; xid: number; flags: number; ciaddr: string; giaddr: string; chaddr: Buffer; messageType: number; options: Map<number, Buffer> }`
  - `function parsePacket(buf: Buffer): DhcpPacket | null`
  - `function clientIdentity(pkt: DhcpPacket): string`
  - `function requestedAddress(pkt: DhcpPacket): string | null`
  - `function serverIdentifier(pkt: DhcpPacket): string | null`
  - `interface BuildReplyInput { request: DhcpPacket; messageType: number; yiaddr: string; hostIp: string; netmask: string; leaseSeconds: number }`
  - `function buildReply(input: BuildReplyInput): Buffer`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dhcpMessage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DHCP,
  parsePacket,
  buildReply,
  clientIdentity,
  requestedAddress,
  serverIdentifier,
} from '../../../src/runProxy/dhcpMessage';

const MAC = Buffer.from([0x00, 0x15, 0x5d, 0x00, 0x71, 0x10]);

/** Build a BOOTP/DHCP request for testing. */
function packet(
  messageType: number,
  opts: {
    xid?: number;
    flags?: number;
    ciaddr?: string;
    giaddr?: string;
    chaddr?: Buffer;
    extra?: Array<[number, Buffer]>;
  } = {},
): Buffer {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(1, 0); // op = BOOTREQUEST
  buf.writeUInt8(1, 1); // htype = ethernet
  buf.writeUInt8(6, 2); // hlen
  buf.writeUInt32BE(opts.xid ?? 0xdeadbeef, 4);
  buf.writeUInt16BE(opts.flags ?? 0, 10);
  const ip = (s: string) => s.split('.').map(Number);
  if (opts.ciaddr) Buffer.from(ip(opts.ciaddr)).copy(buf, 12);
  if (opts.giaddr) Buffer.from(ip(opts.giaddr)).copy(buf, 24);
  (opts.chaddr ?? MAC).copy(buf, 28);
  buf.writeUInt32BE(0x63825363, 236); // magic cookie
  let off = 240;
  buf.writeUInt8(53, off++);
  buf.writeUInt8(1, off++);
  buf.writeUInt8(messageType, off++);
  for (const [code, value] of opts.extra ?? []) {
    buf.writeUInt8(code, off++);
    buf.writeUInt8(value.length, off++);
    value.copy(buf, off);
    off += value.length;
  }
  buf.writeUInt8(255, off);
  return buf;
}

describe('parsePacket', () => {
  it('parses a DISCOVER', () => {
    const p = parsePacket(packet(DHCP.DISCOVER));
    expect(p).not.toBeNull();
    expect(p!.messageType).toBe(DHCP.DISCOVER);
    expect(p!.xid).toBe(0xdeadbeef);
    expect(p!.chaddr).toEqual(MAC);
    expect(p!.ciaddr).toBe('0.0.0.0');
    expect(p!.giaddr).toBe('0.0.0.0');
  });

  it('rejects a packet with a bad magic cookie', () => {
    const buf = packet(DHCP.DISCOVER);
    buf.writeUInt32BE(0, 236);
    expect(parsePacket(buf)).toBeNull();
  });

  it('rejects a packet too short to hold the BOOTP header', () => {
    expect(parsePacket(Buffer.alloc(100))).toBeNull();
  });

  it('rejects a packet with no message-type option', () => {
    const buf = Buffer.alloc(300);
    buf.writeUInt8(1, 0);
    buf.writeUInt8(1, 1);
    buf.writeUInt8(6, 2);
    buf.writeUInt32BE(0x63825363, 236);
    buf.writeUInt8(255, 240);
    expect(parsePacket(buf)).toBeNull();
  });

  it('rejects an option whose length runs past the end', () => {
    const buf = packet(DHCP.DISCOVER);
    buf.writeUInt8(50, 243);
    buf.writeUInt8(200, 244); // claims 200 bytes with far fewer remaining
    expect(parsePacket(buf)).toBeNull();
  });

  it('reads the requested address (option 50)', () => {
    const p = parsePacket(
      packet(DHCP.REQUEST, { extra: [[50, Buffer.from([192, 168, 67, 55])]] }),
    );
    expect(requestedAddress(p!)).toBe('192.168.67.55');
  });

  it('reads the server identifier (option 54)', () => {
    const p = parsePacket(packet(DHCP.REQUEST, { extra: [[54, Buffer.from([192, 168, 67, 1])]] }));
    expect(serverIdentifier(p!)).toBe('192.168.67.1');
  });

  it('returns null for absent options', () => {
    const p = parsePacket(packet(DHCP.DISCOVER));
    expect(requestedAddress(p!)).toBeNull();
    expect(serverIdentifier(p!)).toBeNull();
  });
});

describe('clientIdentity', () => {
  it('uses chaddr when option 61 is absent', () => {
    expect(clientIdentity(parsePacket(packet(DHCP.DISCOVER))!)).toBe('00155d007110');
  });

  it('prefers the client identifier (option 61) when present', () => {
    const p = parsePacket(
      packet(DHCP.DISCOVER, { extra: [[61, Buffer.from([0x01, 0xaa, 0xbb])]] }),
    );
    expect(clientIdentity(p!)).toBe('01aabb');
  });

  it('distinguishes two clients with the same MAC but different identifiers', () => {
    const a = parsePacket(packet(DHCP.DISCOVER, { extra: [[61, Buffer.from([1])]] }))!;
    const b = parsePacket(packet(DHCP.DISCOVER, { extra: [[61, Buffer.from([2])]] }))!;
    expect(clientIdentity(a)).not.toBe(clientIdentity(b));
  });
});

describe('buildReply', () => {
  const base = {
    hostIp: '192.168.67.1',
    netmask: '255.255.255.0',
    leaseSeconds: 3600,
  };

  it('builds an OFFER echoing xid and chaddr', () => {
    const request = parsePacket(packet(DHCP.DISCOVER))!;
    const reply = buildReply({ request, messageType: DHCP.OFFER, yiaddr: '192.168.67.10', ...base });

    expect(reply.readUInt8(0)).toBe(2); // op = BOOTREPLY
    expect(reply.readUInt32BE(4)).toBe(0xdeadbeef); // xid echoed
    expect(reply.subarray(16, 20)).toEqual(Buffer.from([192, 168, 67, 10])); // yiaddr
    expect(reply.subarray(20, 24)).toEqual(Buffer.from([192, 168, 67, 1])); // siaddr
    expect(reply.subarray(28, 34)).toEqual(MAC); // chaddr echoed
    expect(reply.readUInt32BE(236)).toBe(0x63825363); // magic cookie
  });

  it('serves router, DNS, mask, lease time, server id and T1/T2', () => {
    const request = parsePacket(packet(DHCP.DISCOVER))!;
    const reply = buildReply({ request, messageType: DHCP.ACK, yiaddr: '192.168.67.10', ...base });

    const options = new Map<number, Buffer>();
    let off = 240;
    while (off < reply.length && reply.readUInt8(off) !== 255) {
      const code = reply.readUInt8(off);
      const len = reply.readUInt8(off + 1);
      options.set(code, reply.subarray(off + 2, off + 2 + len));
      off += 2 + len;
    }

    expect(options.get(53)!.readUInt8(0)).toBe(DHCP.ACK);
    expect(options.get(1)).toEqual(Buffer.from([255, 255, 255, 0])); // subnet mask
    expect(options.get(3)).toEqual(Buffer.from([192, 168, 67, 1])); // router
    expect(options.get(6)).toEqual(Buffer.from([192, 168, 67, 1])); // DNS
    expect(options.get(54)).toEqual(Buffer.from([192, 168, 67, 1])); // server id
    expect(options.get(51)!.readUInt32BE(0)).toBe(3600); // lease time
    expect(options.get(58)!.readUInt32BE(0)).toBe(1800); // T1 = 50%
    expect(options.get(59)!.readUInt32BE(0)).toBe(3150); // T2 = 87.5%
  });

  it('omits addressing options from a NAK', () => {
    const request = parsePacket(packet(DHCP.REQUEST))!;
    const reply = buildReply({ request, messageType: DHCP.NAK, yiaddr: '0.0.0.0', ...base });

    const codes = new Set<number>();
    let off = 240;
    while (off < reply.length && reply.readUInt8(off) !== 255) {
      const code = reply.readUInt8(off);
      codes.add(code);
      off += 2 + reply.readUInt8(off + 1);
    }
    expect(codes.has(53)).toBe(true);
    expect(codes.has(54)).toBe(true);
    expect(codes.has(1)).toBe(false);
    expect(codes.has(51)).toBe(false);
    expect(reply.subarray(16, 20)).toEqual(Buffer.from([0, 0, 0, 0]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dhcpMessage.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/dhcpMessage`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dhcpMessage.ts`:

```ts
import { intToIp, ipToInt } from './ip';

export const DHCP = {
  DISCOVER: 1,
  OFFER: 2,
  REQUEST: 3,
  DECLINE: 4,
  ACK: 5,
  NAK: 6,
  RELEASE: 7,
  INFORM: 8,
} as const;

const MAGIC_COOKIE = 0x63825363;
const BOOTP_MIN_LEN = 240; // fixed header + cookie
const OPT_END = 255;
const OPT_PAD = 0;

const OPT_SUBNET_MASK = 1;
const OPT_ROUTER = 3;
const OPT_DNS = 6;
const OPT_REQUESTED_IP = 50;
const OPT_LEASE_TIME = 51;
const OPT_MESSAGE_TYPE = 53;
const OPT_SERVER_ID = 54;
const OPT_CLIENT_ID = 61;
const OPT_T1 = 58;
const OPT_T2 = 59;

export interface DhcpPacket {
  op: number;
  xid: number;
  flags: number;
  ciaddr: string;
  giaddr: string;
  chaddr: Buffer;
  messageType: number;
  options: Map<number, Buffer>;
}

function readIp(buf: Buffer, offset: number): string {
  return intToIp(buf.readUInt32BE(offset));
}

function writeIp(buf: Buffer, offset: number, ip: string): void {
  buf.writeUInt32BE(ipToInt(ip), offset);
}

/** Returns null for anything malformed. Callers drop rather than guess. */
export function parsePacket(buf: Buffer): DhcpPacket | null {
  if (buf.length < BOOTP_MIN_LEN) return null;
  if (buf.readUInt32BE(236) !== MAGIC_COOKIE) return null;

  const hlen = buf.readUInt8(2);
  if (hlen < 1 || hlen > 16) return null;

  const options = new Map<number, Buffer>();
  let off = BOOTP_MIN_LEN;
  for (;;) {
    if (off >= buf.length) return null; // ran off the end without an END option
    const code = buf.readUInt8(off);
    if (code === OPT_END) break;
    if (code === OPT_PAD) {
      off += 1;
      continue;
    }
    if (off + 1 >= buf.length) return null;
    const len = buf.readUInt8(off + 1);
    if (off + 2 + len > buf.length) return null;
    options.set(code, buf.subarray(off + 2, off + 2 + len));
    off += 2 + len;
  }

  const type = options.get(OPT_MESSAGE_TYPE);
  if (!type || type.length !== 1) return null;

  return {
    op: buf.readUInt8(0),
    xid: buf.readUInt32BE(4),
    flags: buf.readUInt16BE(10),
    ciaddr: readIp(buf, 12),
    giaddr: readIp(buf, 24),
    chaddr: Buffer.from(buf.subarray(28, 28 + hlen)),
    messageType: type.readUInt8(0),
    options,
  };
}

/**
 * Identity used to key leases. Option 61 wins when present: some clients send it
 * and expect it to be authoritative, and keying inconsistently would hand the same
 * client two different addresses.
 */
export function clientIdentity(pkt: DhcpPacket): string {
  const clientId = pkt.options.get(OPT_CLIENT_ID);
  return (clientId ?? pkt.chaddr).toString('hex');
}

export function requestedAddress(pkt: DhcpPacket): string | null {
  const opt = pkt.options.get(OPT_REQUESTED_IP);
  return opt && opt.length === 4 ? intToIp(opt.readUInt32BE(0)) : null;
}

export function serverIdentifier(pkt: DhcpPacket): string | null {
  const opt = pkt.options.get(OPT_SERVER_ID);
  return opt && opt.length === 4 ? intToIp(opt.readUInt32BE(0)) : null;
}

export interface BuildReplyInput {
  request: DhcpPacket;
  messageType: number;
  yiaddr: string;
  hostIp: string;
  netmask: string;
  leaseSeconds: number;
}

export function buildReply(input: BuildReplyInput): Buffer {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(2, 0); // op = BOOTREPLY
  buf.writeUInt8(1, 1); // htype = ethernet
  buf.writeUInt8(input.request.chaddr.length, 2);
  buf.writeUInt32BE(input.request.xid, 4);
  buf.writeUInt16BE(input.request.flags, 10);
  writeIp(buf, 12, input.request.ciaddr);
  writeIp(buf, 16, input.yiaddr);
  writeIp(buf, 20, input.hostIp); // siaddr
  writeIp(buf, 24, input.request.giaddr);
  input.request.chaddr.copy(buf, 28);
  buf.writeUInt32BE(MAGIC_COOKIE, 236);

  let off = BOOTP_MIN_LEN;
  const writeOpt = (code: number, value: Buffer): void => {
    buf.writeUInt8(code, off++);
    buf.writeUInt8(value.length, off++);
    value.copy(buf, off);
    off += value.length;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const ipBytes = (ip: string): Buffer => u32(ipToInt(ip));

  writeOpt(OPT_MESSAGE_TYPE, Buffer.from([input.messageType]));
  writeOpt(OPT_SERVER_ID, ipBytes(input.hostIp));

  // A NAK carries no addressing information - it only tells the client to start over.
  if (input.messageType !== DHCP.NAK) {
    writeOpt(OPT_SUBNET_MASK, ipBytes(input.netmask));
    // Router and DNS are both the host. Nothing should route off-subnet, since every
    // name resolves to the host, but clients behave better with a default route
    // present - and this replaces the guarded default-route hack the Ubuntu guest
    // used to install by hand.
    writeOpt(OPT_ROUTER, ipBytes(input.hostIp));
    writeOpt(OPT_DNS, ipBytes(input.hostIp));
    writeOpt(OPT_LEASE_TIME, u32(input.leaseSeconds));
    writeOpt(OPT_T1, u32(Math.floor(input.leaseSeconds * 0.5)));
    writeOpt(OPT_T2, u32(Math.floor(input.leaseSeconds * 0.875)));
  }

  buf.writeUInt8(OPT_END, off++);
  return buf.subarray(0, Math.max(off, BOOTP_MIN_LEN + 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dhcpMessage.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dhcpMessage.ts tests/unit/runProxy/dhcpMessage.test.ts
git commit -m "feat: add DHCP message codec"
```

---

### Task 9: DHCP state machine

**Files:**

- Create: `src/runProxy/dhcpHandler.ts`
- Test: `tests/unit/runProxy/dhcpHandler.test.ts`

**Interfaces:**

- Consumes: `DHCP`, `parsePacket`, `buildReply`, `clientIdentity`, `requestedAddress`, `serverIdentifier`, `DhcpPacket` from `src/runProxy/dhcpMessage`; `LeaseTable` from `src/runProxy/dhcpLeases`.
- Produces:
  - `interface DhcpReply { buffer: Buffer; destination: string }`
  - `interface DhcpHandlerOptions { hostIp: string; netmask: string; leaseSeconds: number; leases: LeaseTable; onWarn?: (message: string) => void }`
  - `function handleDhcp(pkt: DhcpPacket, opts: DhcpHandlerOptions): DhcpReply | null`

`destination` is `'255.255.255.255'` when the client has no usable address yet — a unicast reply would require ARP for an address it does not hold. This is the path Phase 0 could **not** validate, so its tests matter disproportionately.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dhcpHandler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { handleDhcp } from '../../../src/runProxy/dhcpHandler';
import { DHCP, parsePacket, type DhcpPacket } from '../../../src/runProxy/dhcpMessage';
import { createLeaseTable, type LeaseTable } from '../../../src/runProxy/dhcpLeases';

const MAC = Buffer.from([0x00, 0x15, 0x5d, 0x00, 0x71, 0x10]);

function packet(
  messageType: number,
  opts: { ciaddr?: string; giaddr?: string; extra?: Array<[number, Buffer]> } = {},
): DhcpPacket {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(6, 2);
  buf.writeUInt32BE(0xabcd1234, 4);
  const ip = (s: string) => Buffer.from(s.split('.').map(Number));
  if (opts.ciaddr) ip(opts.ciaddr).copy(buf, 12);
  if (opts.giaddr) ip(opts.giaddr).copy(buf, 24);
  MAC.copy(buf, 28);
  buf.writeUInt32BE(0x63825363, 236);
  let off = 240;
  buf.writeUInt8(53, off++);
  buf.writeUInt8(1, off++);
  buf.writeUInt8(messageType, off++);
  for (const [code, value] of opts.extra ?? []) {
    buf.writeUInt8(code, off++);
    buf.writeUInt8(value.length, off++);
    value.copy(buf, off);
    off += value.length;
  }
  buf.writeUInt8(255, off);
  return parsePacket(buf)!;
}

function options(leases: LeaseTable = createLeaseTable({
  hostIp: '192.168.67.1',
  netmask: '255.255.255.0',
  leaseSeconds: 3600,
})) {
  return { hostIp: '192.168.67.1', netmask: '255.255.255.0', leaseSeconds: 3600, leases };
}

/** Read the message type out of a reply buffer. */
function replyType(buf: Buffer): number {
  let off = 240;
  while (off < buf.length && buf.readUInt8(off) !== 255) {
    const code = buf.readUInt8(off);
    const len = buf.readUInt8(off + 1);
    if (code === 53) return buf.readUInt8(off + 2);
    off += 2 + len;
  }
  throw new Error('no message type in reply');
}

describe('DISCOVER', () => {
  it('offers an address, broadcast because the client has none yet', () => {
    const reply = handleDhcp(packet(DHCP.DISCOVER), options());
    expect(reply).not.toBeNull();
    expect(replyType(reply!.buffer)).toBe(DHCP.OFFER);
    expect(reply!.destination).toBe('255.255.255.255');
  });

  it('returns no reply when the pool is exhausted', () => {
    const leases = createLeaseTable({
      hostIp: '192.168.67.1',
      netmask: '255.255.255.0',
      leaseSeconds: 3600,
      poolStart: 10,
      poolEnd: 10,
    });
    leases.acquire('someone-else');
    expect(handleDhcp(packet(DHCP.DISCOVER), options(leases))).toBeNull();
  });
});

describe('REQUEST', () => {
  it('ACKs a SELECTING request addressed to us', () => {
    const opts = options();
    const offered = handleDhcp(packet(DHCP.DISCOVER), opts)!;
    const yiaddr = offered.buffer.subarray(16, 20).join('.');
    const reply = handleDhcp(
      packet(DHCP.REQUEST, {
        extra: [
          [54, Buffer.from([192, 168, 67, 1])],
          [50, Buffer.from(yiaddr.split('.').map(Number))],
        ],
      }),
      opts,
    );
    expect(replyType(reply!.buffer)).toBe(DHCP.ACK);
  });

  it('stays silent when the client selected a different server', () => {
    const reply = handleDhcp(
      packet(DHCP.REQUEST, {
        extra: [
          [54, Buffer.from([10, 0, 0, 1])],
          [50, Buffer.from([192, 168, 67, 20])],
        ],
      }),
      options(),
    );
    expect(reply).toBeNull();
  });

  it('ACKs an INIT-REBOOT request for an in-range address', () => {
    const reply = handleDhcp(
      packet(DHCP.REQUEST, { extra: [[50, Buffer.from([192, 168, 67, 55])]] }),
      options(),
    );
    expect(replyType(reply!.buffer)).toBe(DHCP.ACK);
    expect(reply!.destination).toBe('255.255.255.255');
  });

  it('NAKs an INIT-REBOOT request for an out-of-range address', () => {
    const reply = handleDhcp(
      packet(DHCP.REQUEST, { extra: [[50, Buffer.from([10, 9, 9, 9])]] }),
      options(),
    );
    expect(replyType(reply!.buffer)).toBe(DHCP.NAK);
  });

  it('ACKs a RENEWING request unicast back to ciaddr', () => {
    const reply = handleDhcp(packet(DHCP.REQUEST, { ciaddr: '192.168.67.55' }), options());
    expect(replyType(reply!.buffer)).toBe(DHCP.ACK);
    expect(reply!.destination).toBe('192.168.67.55');
  });

  it('NAKs a REQUEST carrying neither ciaddr nor option 50', () => {
    const reply = handleDhcp(packet(DHCP.REQUEST), options());
    expect(replyType(reply!.buffer)).toBe(DHCP.NAK);
  });
});

describe('RELEASE, DECLINE, INFORM', () => {
  it('frees the lease on RELEASE and sends nothing', () => {
    const opts = options();
    const offered = handleDhcp(packet(DHCP.DISCOVER), opts)!;
    const yiaddr = offered.buffer.subarray(16, 20).join('.');
    expect(handleDhcp(packet(DHCP.RELEASE), opts)).toBeNull();
    // The address is free again, so the next client can take it.
    expect(opts.leases.request('other-client', yiaddr)).toBe('ack');
  });

  it('sends nothing on DECLINE', () => {
    expect(
      handleDhcp(
        packet(DHCP.DECLINE, { extra: [[50, Buffer.from([192, 168, 67, 30])]] }),
        options(),
      ),
    ).toBeNull();
  });

  it('ACKs an INFORM with no yiaddr', () => {
    const reply = handleDhcp(packet(DHCP.INFORM, { ciaddr: '192.168.67.60' }), options());
    expect(replyType(reply!.buffer)).toBe(DHCP.ACK);
    expect(reply!.buffer.subarray(16, 20)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(reply!.destination).toBe('192.168.67.60');
  });
});

describe('guards', () => {
  it('ignores relayed packets', () => {
    expect(handleDhcp(packet(DHCP.DISCOVER, { giaddr: '10.0.0.1' }), options())).toBeNull();
  });

  it('ignores message types it does not serve', () => {
    expect(handleDhcp(packet(DHCP.OFFER), options())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dhcpHandler.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/dhcpHandler`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dhcpHandler.ts`:

```ts
import {
  DHCP,
  buildReply,
  clientIdentity,
  requestedAddress,
  serverIdentifier,
  type DhcpPacket,
} from './dhcpMessage';
import type { LeaseTable } from './dhcpLeases';

const UNSPECIFIED = '0.0.0.0';
const BROADCAST = '255.255.255.255';

export interface DhcpReply {
  buffer: Buffer;
  /** '255.255.255.255' or a unicast address. Port is always 68. */
  destination: string;
}

export interface DhcpHandlerOptions {
  hostIp: string;
  netmask: string;
  leaseSeconds: number;
  leases: LeaseTable;
  onWarn?: (message: string) => void;
}

/**
 * RFC 2131 state machine, as a pure function. Returns null when the correct
 * behaviour is to stay silent.
 *
 * Reply destination: a client in SELECTING or INIT-REBOOT has no usable address,
 * so a unicast reply would require ARP for an address it does not hold - those go
 * to the limited broadcast address. Only RENEWING/REBINDING clients, which set
 * ciaddr, are answered unicast.
 */
export function handleDhcp(pkt: DhcpPacket, opts: DhcpHandlerOptions): DhcpReply | null {
  // A relay agent implies a routed topology this design does not support.
  if (pkt.giaddr !== UNSPECIFIED) {
    opts.onWarn?.(`dhcp: ignoring relayed packet from giaddr ${pkt.giaddr}`);
    return null;
  }

  const identity = clientIdentity(pkt);
  const hasCiaddr = pkt.ciaddr !== UNSPECIFIED;
  const destination = hasCiaddr ? pkt.ciaddr : BROADCAST;

  const reply = (messageType: number, yiaddr: string): DhcpReply => ({
    buffer: buildReply({
      request: pkt,
      messageType,
      yiaddr,
      hostIp: opts.hostIp,
      netmask: opts.netmask,
      leaseSeconds: opts.leaseSeconds,
    }),
    destination,
  });

  switch (pkt.messageType) {
    case DHCP.DISCOVER: {
      const address = opts.leases.acquire(identity);
      if (!address) {
        opts.onWarn?.(`dhcp: address pool exhausted; no offer for ${identity}`);
        return null;
      }
      return reply(DHCP.OFFER, address);
    }

    case DHCP.REQUEST: {
      const chosen = serverIdentifier(pkt);
      // The client picked someone else's offer; drop ours and stay quiet.
      if (chosen !== null && chosen !== opts.hostIp) {
        opts.leases.release(identity);
        return null;
      }

      // SELECTING / INIT-REBOOT carry the address in option 50; RENEWING and
      // REBINDING carry it in ciaddr.
      const wanted = requestedAddress(pkt) ?? (hasCiaddr ? pkt.ciaddr : null);
      if (!wanted) return reply(DHCP.NAK, UNSPECIFIED);

      return opts.leases.request(identity, wanted) === 'ack'
        ? reply(DHCP.ACK, wanted)
        : reply(DHCP.NAK, UNSPECIFIED);
    }

    case DHCP.RELEASE:
      opts.leases.release(identity);
      return null;

    case DHCP.DECLINE: {
      const bad = requestedAddress(pkt);
      if (bad) opts.leases.decline(bad);
      opts.onWarn?.(`dhcp: client ${identity} declined ${bad ?? 'an address'}`);
      return null;
    }

    case DHCP.INFORM:
      // Configuration only - the client already has an address of its own.
      return reply(DHCP.ACK, UNSPECIFIED);

    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dhcpHandler.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dhcpHandler.ts tests/unit/runProxy/dhcpHandler.test.ts
git commit -m "feat: add DHCP state machine"
```

---

### Task 10: DHCP server socket

**Files:**

- Create: `src/runProxy/dhcpServer.ts`
- Test: `tests/unit/runProxy/dhcpServer.test.ts`

**Interfaces:**

- Consumes: `parsePacket` from `dhcpMessage`, `handleDhcp` from `dhcpHandler`, `createLeaseTable` from `dhcpLeases`.
- Produces:
  - `interface DhcpServerOptions { listenAddress: string; netmask: string; leaseSeconds?: number; port?: number; clientPort?: number; onWarn?: (message: string) => void; onError?: (message: string) => void }`
  - `interface DhcpServerHandle { readonly port: number; close(): Promise<void> }`
  - `function startDhcpServer(opts: DhcpServerOptions): Promise<DhcpServerHandle>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/dhcpServer.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { startDhcpServer, type DhcpServerHandle } from '../../../src/runProxy/dhcpServer';

let handle: DhcpServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

function discover(): Buffer {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(6, 2);
  buf.writeUInt32BE(0x5150, 4);
  Buffer.from([0x00, 0x15, 0x5d, 0x00, 0x71, 0x10]).copy(buf, 28);
  buf.writeUInt32BE(0x63825363, 236);
  buf.writeUInt8(53, 240);
  buf.writeUInt8(1, 241);
  buf.writeUInt8(1, 242); // DISCOVER
  buf.writeUInt8(255, 243);
  return buf;
}

describe('startDhcpServer', () => {
  it('replies to a DISCOVER with an OFFER', async () => {
    // Client socket first, so we know the port the server should reply to.
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((r) => client.bind(0, '127.0.0.1', r));
    const clientPort = client.address().port;

    handle = await startDhcpServer({
      listenAddress: '127.0.0.1',
      netmask: '255.255.255.0',
      port: 0,
      clientPort,
    });

    const reply = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      client.on('message', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      client.send(discover(), handle!.port, '127.0.0.1');
    });

    expect(reply.readUInt8(0)).toBe(2); // BOOTREPLY
    expect(reply.readUInt32BE(4)).toBe(0x5150); // xid echoed
    expect(reply.readUInt8(242)).toBe(2); // OFFER
    client.close();
  });

  it('rejects a bind to an address the host does not own', async () => {
    await expect(
      startDhcpServer({ listenAddress: '203.0.113.9', netmask: '255.255.255.0', port: 0 }),
    ).rejects.toThrow();
  });

  it('close() releases the port', async () => {
    const h = await startDhcpServer({
      listenAddress: '127.0.0.1',
      netmask: '255.255.255.0',
      port: 0,
    });
    const port = h.port;
    await h.close();
    const again = await startDhcpServer({
      listenAddress: '127.0.0.1',
      netmask: '255.255.255.0',
      port,
    });
    expect(again.port).toBe(port);
    await again.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/dhcpServer.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/dhcpServer`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/dhcpServer.ts`:

```ts
import dgram from 'node:dgram';
import { parsePacket } from './dhcpMessage';
import { handleDhcp } from './dhcpHandler';
import { createLeaseTable } from './dhcpLeases';

const DEFAULT_LEASE_SECONDS = 3600;

export interface DhcpServerOptions {
  /** Specific adapter address to bind. Binding the specific address is also what
   *  scopes the server to the network it owns: packets for other networks are not
   *  delivered to this socket at all. */
  listenAddress: string;
  netmask: string;
  leaseSeconds?: number;
  /** Defaults to 67. Tests pass 0 for an ephemeral port. */
  port?: number;
  /** Defaults to 68. Tests override so a local client socket receives the reply. */
  clientPort?: number;
  onWarn?: (message: string) => void;
  onError?: (message: string) => void;
}

export interface DhcpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function startDhcpServer(opts: DhcpServerOptions): Promise<DhcpServerHandle> {
  const port = opts.port ?? 67;
  const clientPort = opts.clientPort ?? 68;
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const leases = createLeaseTable({
    hostIp: opts.listenAddress,
    netmask: opts.netmask,
    leaseSeconds,
  });

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });

  socket.on('message', (msg) => {
    const pkt = parsePacket(msg);
    if (!pkt) return;

    const reply = handleDhcp(pkt, {
      hostIp: opts.listenAddress,
      netmask: opts.netmask,
      leaseSeconds,
      leases,
      onWarn: opts.onWarn,
    });
    if (!reply) return;

    socket.send(reply.buffer, clientPort, reply.destination, (err) => {
      if (err) opts.onError?.(`dhcp: send to ${reply.destination}:${clientPort} failed: ${err.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, opts.listenAddress, () => {
      socket.removeListener('error', reject);
      // Required to reach clients that have no address yet.
      socket.setBroadcast(true);
      socket.on('error', (err) => opts.onError?.(`dhcp: ${err.message}`));
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((r) => socket.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/dhcpServer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/dhcpServer.ts tests/unit/runProxy/dhcpServer.test.ts
git commit -m "feat: add host-side DHCP server socket"
```

---

### Task 11: Resolve the adapter netmask

**Files:**

- Modify: `src/runProxy/forwarder.ts`
- Test: `tests/unit/runProxy/forwarder.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `interface InternalSwitchNetwork { address: string; netmask: string }`
  - `function resolveInternalSwitchNetwork(adapterName?: string, interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): InternalSwitchNetwork | null`
  - `resolveForwardListenAddress` keeps its existing signature and behaviour.

DHCP option 1 needs the mask, and the lease pool is derived from the network address. Hardcoding `/24` would break on a host whose Internal switch uses a different prefix.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/runProxy/forwarder.test.ts`:

```ts
import { resolveInternalSwitchNetwork } from '../../../src/runProxy/forwarder';

describe('resolveInternalSwitchNetwork', () => {
  it('returns the address and netmask of the named adapter', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [ipv4('192.168.67.1')],
    };
    expect(resolveInternalSwitchNetwork(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)).toEqual({
      address: '192.168.67.1',
      netmask: '255.255.255.0',
    });
  });

  it('returns null when the adapter is absent', () => {
    expect(
      resolveInternalSwitchNetwork(DEFAULT_INTERNAL_SWITCH_ADAPTER, { 'Wi-Fi': [ipv4('10.0.0.5')] }),
    ).toBeNull();
  });

  it('skips internal and IPv6 addresses', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [
        { ...ipv4('127.0.0.1', true) },
        ipv4('192.168.67.1'),
      ],
    };
    expect(resolveInternalSwitchNetwork(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)?.address).toBe(
      '192.168.67.1',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/forwarder.test.ts`
Expected: FAIL — `resolveInternalSwitchNetwork` is not exported.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/runProxy/forwarder.ts` below the `DEFAULT_INTERNAL_SWITCH_ADAPTER` constant with:

```ts
export interface InternalSwitchNetwork {
  address: string;
  netmask: string;
}

/**
 * IPv4 address and netmask of the Hyper-V Internal-switch host adapter, or null if
 * the adapter is not present. `interfaces` is injectable for testing.
 */
export function resolveInternalSwitchNetwork(
  adapterName: string = DEFAULT_INTERNAL_SWITCH_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): InternalSwitchNetwork | null {
  const addrs = interfaces[adapterName];
  if (!addrs) return null;
  for (const a of addrs) {
    if (a.family === 'IPv4' && !a.internal) return { address: a.address, netmask: a.netmask };
  }
  return null;
}

/**
 * IPv4 address of the Hyper-V Internal-switch host adapter to forward from, or
 * null if the adapter is not present. `interfaces` is injectable for testing.
 */
export function resolveForwardListenAddress(
  adapterName: string = DEFAULT_INTERNAL_SWITCH_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  return resolveInternalSwitchNetwork(adapterName, interfaces)?.address ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/forwarder.test.ts`
Expected: PASS, 6 tests (3 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/forwarder.ts tests/unit/runProxy/forwarder.test.ts
git commit -m "feat: resolve the Internal-switch netmask alongside its address"
```

---

### Task 12: Wire DHCP into `run-proxy`, firewall, and verify

**Files:**

- Modify: `src/commands/runProxy.ts`
- Modify: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `templates/proxy/verify-proxy.ps1`

**Interfaces:**

- Consumes: `startDhcpServer` (Task 10), `resolveInternalSwitchNetwork` (Task 11).
- Produces: firewall rule named `Envoy Sandbox Proxy DHCP (VM inbound)`.

- [ ] **Step 1: Add the import**

In `src/commands/runProxy.ts`:

```ts
import { startDhcpServer } from '../runProxy/dhcpServer';
```

and change the existing forwarder import to:

```ts
import { resolveForwardListenAddress, resolveInternalSwitchNetwork } from '../runProxy/forwarder';
```

- [ ] **Step 2: Start the DHCP server after the DNS responder**

Immediately after the `console.log` for the DNS responder added in Task 4 (still inside `if (options.forward) { ... }`), insert:

```ts
        const network = resolveInternalSwitchNetwork();
        const netmask = network?.address === dnsIp ? network.netmask : '255.255.255.0';
        try {
          await services.add(() =>
            startDhcpServer({
              listenAddress: dnsIp,
              netmask,
              onWarn: (message) => console.warn(`run-proxy: ${message}`),
              onError: (message) => console.error(`run-proxy: ${message}`),
            }),
          );
        } catch (err) {
          console.error(
            `run-proxy: failed to bind DHCP on ${dnsIp}:67 — ${String(err)}. ` +
              'Guests on the Internal switch cannot get an address without this.',
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          `run-proxy: DHCP server listening on ${dnsIp}:67 (router and DNS -> ${dnsIp}, mask ${netmask})`,
        );
```

The `network?.address === dnsIp` guard matters: `--forward-listen` can point at an address that is not the auto-detected adapter, and silently pairing it with the wrong mask would produce an unusable pool.

- [ ] **Step 3: Add the firewall rule**

In `templates/proxy/host-allow-vm-inbound.ps1`, extend the rule block from Task 5:

```powershell
$dhcpRuleName = "Envoy Sandbox Proxy DHCP (VM inbound)"
Get-NetFirewallRule -DisplayName $dhcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null
```

and add `UDP 67 - run-proxy's DHCP server` to the header comment's port list.

- [ ] **Step 4: Add the verify check**

In `templates/proxy/verify-proxy.ps1`, extend the block added in Task 5:

```powershell
$dhcpRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DHCP (VM inbound)' -ErrorAction SilentlyContinue
if ($dhcpRule) { Add-Pass 'Internal-switch inbound DHCP firewall rule present' }
else { Add-Warn 'Internal-switch inbound DHCP firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }
```

and inside the `if ($hostIp) { ... }` block:

```powershell
    $dhcpListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 67 -ErrorAction SilentlyContinue
    if ($dhcpListener) { Add-Pass "DHCP server listening on ${hostIp}:67" }
    else { Add-Fail "DHCP server listening on ${hostIp}:67" "not found -- is run-proxy running? guests cannot get an address" }
```

- [ ] **Step 5: Verify types and the full unit suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Verify manually on the host**

Elevated: `.\.configamatron\proxy\host-allow-vm-inbound.ps1`, then run `pnpm cli run-proxy` and in a second terminal:

```powershell
Get-NetUDPEndpoint -LocalPort 53,67 | Select-Object LocalAddress,LocalPort,OwningProcess
```

Expected: `192.168.67.1:53` and `192.168.67.1:67` owned by node, coexisting with ICS's `0.0.0.0:53` and `172.17.224.1:67`. Then `.\.configamatron\proxy\verify-proxy.ps1` — expect PASS on all four new checks.

- [ ] **Step 7: Commit**

```bash
git add src/commands/runProxy.ts templates/proxy/host-allow-vm-inbound.ps1 templates/proxy/verify-proxy.ps1
git commit -m "feat: serve DHCP from run-proxy on the Internal-switch adapter"
```

---

# PHASE 3 — Host-side documentation

### Task 13: Host setup ordering and SMB scope

**Files:**

- Modify: `usage-hyper-v.md` (host sections only — lines 8, 16-29, 49-57, 221-235)
- Modify: `templates/proxy/host-allow-vm-inbound.ps1` (SMB scope)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

Only host-side content changes here. The guest flow stays as-is until Phases 4 and 5, so the tree never documents a procedure the shipped templates cannot perform.

- [ ] **Step 1: Widen the SMB firewall scope**

The share carries the numbered scripts but is served only on the Internal switch, while the internet is on the NAT switch — with one adapter active at a time they are never both available. Add to `templates/proxy/host-allow-vm-inbound.ps1`, after the DHCP rule:

```powershell
# The numbered scripts live on the SMB share but download from the internet, and a
# guest has only one adapter active at a time. Serving the share on the Default
# Switch too lets those scripts run during the NAT phase over direct internet,
# exactly as they do today.
#
# This is narrower than it sounds: the Default Switch is Hyper-V's NAT network,
# unreachable from the LAN or the internet. The share holds no secrets - cert.pem is
# the CA's PUBLIC certificate and the credential files are sanitized placeholders;
# real tokens live in .configamatron/proxy/secrets and are injected by Envoy.
# Permanent rather than setup-only is deliberate: re-scoping between phases is a
# manual step that fails OPEN when forgotten.
$smbRuleName = "Configamatron share (VM inbound)"
Get-NetFirewallRule -DisplayName $smbRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias, $NatAdapterAlias -Action Allow | Out-Null
```

and add the parameter:

```powershell
    [string]$NatAdapterAlias = "vEthernet (Default Switch)"
```

- [ ] **Step 2: Move host readiness ahead of the guest scripts**

In `usage-hyper-v.md`, move the "open the firewall and start forwarding" step (currently around line 223, under `## 7. Isolate`) to immediately after the switch/IP creation section, and introduce it with:

```markdown
### Start the host services before booting the VM into the isolated network

`run-proxy` now serves **DNS and DHCP** for the isolated network, not just the
proxy. A guest booted onto `configamatron-internal` while `run-proxy` is down gets
no address at all — which also costs it the SMB mount and any network-based
administration. Start these before that first isolated boot:

```powershell
# Firewall for Envoy 80/443, DNS 53, DHCP 67 and the SMB share; prints the host IP:
.\.configamatron\proxy\host-allow-vm-inbound.ps1

# Gateway + DNS + DHCP on that adapter:
configamatron run-proxy
```

If `run-proxy` is stopped later, a guest that already holds a lease keeps working
until renewal; a guest booting fresh will retry DHCP indefinitely and pick up an
address as soon as `run-proxy` returns, with no console intervention needed.
```

- [ ] **Step 3: Document the two host IPs and their different stability**

In the "One host IP, used everywhere" callout around line 18, append:

```markdown
> **Two host addresses, only one of them stable.** The Internal-switch IP above is
> assigned by you and never changes. The **Default Switch** address (used only
> during the NAT phase, to reach the SMB share) is assigned by Hyper-V and is
> **regenerated across host reboots** — look it up when you need it rather than
> writing it down:
>
> ```powershell
> Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4 |
>     Select-Object IPAddress
> ```
```

- [ ] **Step 4: Update the SMB share section**

In the share section around line 49-57, replace the "scope SMB to the Internal adapter only — never expose it on the external NIC" instruction with:

```markdown
`host-allow-vm-inbound.ps1` scopes SMB (TCP 445) to the Internal-switch adapter
**and** the Default Switch adapter, so the share is reachable in both the NAT and
isolated phases. It is never exposed on the external NIC.
```

- [ ] **Step 5: Verify the docs render and links resolve**

Run: `pnpm format:check`
Expected: PASS. Read the changed sections top to bottom and confirm the ordering now reads: create switch → assign host IP → create shares → **start host services** → create VM → guest setup.

- [ ] **Step 6: Commit**

```bash
git add usage-hyper-v.md templates/proxy/host-allow-vm-inbound.ps1
git commit -m "docs: start host services before the isolated boot; widen SMB scope"
```

---

# PHASE 4 — Windows guest

### Task 14: Delete the in-guest DNS responder

**Files:**

- Delete: `templates/vm-shared-windows/pre-scripts/dns-responder/` (whole directory)
- Modify: `templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1`
- Modify: whichever module defines `isDnsResponderBuildArtifact` (find it in step 1)
- Modify: `templates/vm-shared-windows/verify-config.ps1`

**Interfaces:**

- Consumes: the host DNS responder (Task 4) and DHCP server (Task 12), both already shipping.
- Produces: nothing.

- [ ] **Step 1: Find every reference before deleting anything**

Run:

```bash
grep -rn "dns-responder\|DnsResponder\|isDnsResponderBuildArtifact\|responder-config" --include=*.ts --include=*.ps1 --include=*.md . | grep -v node_modules | grep -v "^./docs/"
```

Expected: hits in the responder project itself, `nn-configure-network.ps1`, a build/packaging module, and possibly `templates.test.ts`. Note each path — every one must be handled in this task.

- [ ] **Step 2: Delete the responder project**

```bash
git rm -r templates/vm-shared-windows/pre-scripts/dns-responder
```

- [ ] **Step 3: Strip the responder from the guest network script**

In `templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1`, delete the `responder-config.txt` write (around line 56-57), the entire Scheduled Task registration block (around lines 59-68), and the adapter loop that points DNS at `127.0.0.1` (around lines 70-77). Replace that whole region with:

```powershell
# DNS and the default route now arrive via DHCP from the host (option 6 and option
# 3), so there is nothing to configure here. The adapter stays on DHCP for both the
# NAT and isolated networks, which is what makes switching between them a pure
# host-side operation.
Clear-DnsClientCache

Write-Host "05-configure-network: CA trusted; DNS and addressing come from the host via DHCP"
```

- [ ] **Step 4: Remove the build wiring**

Delete the `isDnsResponderBuildArtifact` function and every call site found in step 1. If it is the only export of its module, delete the module and its test too.

- [ ] **Step 5: Update the guest verify script**

In `templates/vm-shared-windows/verify-config.ps1`, replace any check for the responder process/task or for DNS being `127.0.0.1` with:

```powershell
$dns = (Get-DnsClientServerAddress -AddressFamily IPv4 |
        Where-Object { $_.ServerAddresses -contains $HostIp } | Select-Object -First 1)
if ($dns) { Add-Pass "resolver points at the host ($HostIp)" }
else { Add-Fail "resolver points at the host ($HostIp)" "got: $((Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses -join ',')" }

$resolved = (Resolve-DnsName -Name example.com -Type A -DnsOnly -NoHostsFile -ErrorAction SilentlyContinue |
             Where-Object Type -eq 'A' | Select-Object -First 1).IPAddress
if ($resolved -eq $HostIp) { Add-Pass "names resolve to the host ($resolved)" }
else { Add-Fail "names resolve to the host" "example.com -> '$resolved', expected $HostIp" }

if (-not (Get-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -ErrorAction SilentlyContinue)) {
    Add-Pass 'no in-guest DNS responder task (DNS is served by the host)'
} else {
    Add-Fail 'no in-guest DNS responder task' 'ConfigamatronDnsResponder is still registered -- remove it'
}
```

- [ ] **Step 6: Run the full gate**

Run: `pnpm test`
Expected: PASS. If `templates.test.ts` fails because it asserted the responder shipped into the share, delete that assertion — the responder is gone by design.

- [ ] **Step 7: Commit**

```bash
git add -A templates/vm-shared-windows src tests
git commit -m "feat: remove the in-guest Windows DNS responder"
```

---

### Task 15: Windows guest documentation

**Files:**

- Modify: `usage-windows-vm.md`
- Modify: `usage-hyper-v.md` (Windows guest section, around lines 89-96, 117, 193-200, 235)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Replace the two-adapter VM creation**

In `usage-hyper-v.md`, replace the "Add a second network adapter" instructions (around lines 89-96) with:

```markdown
  - Hardware -> Network Adapter
    - Set "Virtual Switch" to **"Default Switch"** for now. The VM uses **one**
      adapter throughout; only which switch it is attached to changes.
```

- [ ] **Step 2: Replace the static-IP section with DHCP**

Replace the Windows guest static-IP block (around lines 193-200) with:

```markdown
**Windows guest** — leave the adapter on **DHCP**. That is the whole network
configuration: on the Default Switch it takes a lease from Hyper-V's ICS (real
gateway and DNS, for installing packages); on `configamatron-internal` it takes a
lease from `run-proxy` (the host as both router and DNS). Nothing in the guest
changes between the two.

Save a credential so the share mounts without prompting:

```powershell
cmdkey /add:<host-ip> /user:configamatron-share /pass
```

Use the **Default Switch** host IP during the NAT phase and the Internal-switch
host IP afterwards; `cmdkey` entries are per-address, so add both.
```

- [ ] **Step 3: Replace the isolate step**

Replace the "remove the temporary Default Switch adapter" step (around line 235) with:

```markdown
### Isolate the VM

Shut the guest down, then reassign its single adapter to the isolated switch:

```powershell
Stop-VM -Name '<VMName>'
Connect-VMNetworkAdapter -VMName '<VMName>' -SwitchName 'configamatron-internal'
Start-VM -Name '<VMName>'
```

Confirm `run-proxy` is running **before** starting the VM — it is the guest's only
DHCP server and only resolver. To reverse the isolation later, reassign the same
adapter back to `Default Switch`; no guest-side change is needed in either
direction.
```

- [ ] **Step 4: Update `usage-windows-vm.md`**

Remove any step that runs or references the in-guest DNS responder, and point the network/isolation steps at `usage-hyper-v.md`. State that the numbered scripts run during the **NAT phase**, while the guest still has direct internet.

- [ ] **Step 5: Verify formatting**

Run: `pnpm format:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add usage-hyper-v.md usage-windows-vm.md
git commit -m "docs: single-adapter DHCP flow for the Windows guest"
```

---

### Task 16: Manual checkpoint — Windows guest (retires A6)

**Files:** none. This task produces a result recorded in the spec, not code.

**Interfaces:**

- Consumes: everything from Phases 1-4.
- Produces: the A6 verdict that gates Phase 5.

No automated layer can cover this: the WSL harness cannot exercise Windows binding, Windows Firewall, or a real Windows DHCP client. **The DHCP reply path is the main remaining unknown** — Phase 0 proved a `DISCOVER` *arrives*, never that an `OFFER` gets back to a client with no address.

- [ ] **Step 1: Full setup flow on a real Windows guest**

Guest on Default Switch → run the numbered scripts (direct internet, share mounted via the Default Switch host IP) → shut down → `Connect-VMNetworkAdapter -SwitchName 'configamatron-internal'` → boot with `run-proxy` already running.

Record: `ipconfig /all` showing an address in the pool with the host as router and DNS.

- [ ] **Step 2: DORA and renewal**

In the guest:

```powershell
ipconfig /release
ipconfig /renew
ipconfig /all
```

Expected: the same address returns, with the host as router and DNS. On the host, `run-proxy` logs no warnings.

- [ ] **Step 3: Late host start**

Shut the guest down, stop `run-proxy`, boot the guest, wait ~60s (it will have no address), then start `run-proxy`.

Expected: the guest acquires a lease **without console intervention**. If it does not, decision 5 is in trouble — record the failure and stop before Phase 5.

- [ ] **Step 4: Restart under load**

With the guest holding a lease, Ctrl+C `run-proxy` and start it again. Then in the guest: `ipconfig /renew`.

Expected: ACK, not NAK — the guest keeps its address. This exercises the restart-adoption path in `dhcpLeases.request`.

- [ ] **Step 5: End-to-end and blue/green**

In the guest: `Invoke-WebRequest -Uri https://api.anthropic.com -Method Head -UseBasicParsing`. A 4xx is success — it means transport worked.

Then touch `allowlist.txt` on the host to trigger a blue/green swap, and confirm DNS and DHCP keep answering throughout.

- [ ] **Step 6: Authenticated SMB mount**

With the guest on the Default Switch and the saved credential in place, mount `\\<default-switch-ip>\vm-shared-windows` and list it. This closes the half of A4 that Phase 0 left open.

- [ ] **Step 7: Record the results in the spec**

Update the "Validation results" section of `docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md` with the A6 verdict and the A4 completion. Record failures as failures.

```bash
git add docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md
git commit -m "docs: record A6 validation results from the Windows guest checkpoint"
```

---

# PHASE 5 — Ubuntu guest

### Task 17: Delete the in-guest DNS/DNAT/route layer

**Files:**

- Delete: `templates/vm-shared/pre-scripts/dnsmasq-stub.conf`
- Delete: `templates/vm-shared/pre-scripts/configamatron-egress.service`
- Delete: `templates/vm-shared/pre-scripts/60-dns-override.yaml`
- Modify: `templates/vm-shared/pre-scripts/nn-configure-network.sh:57-89`
- Modify: `templates/vm-shared/verify-config.sh`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: the host DNS/DHCP services, proven at the Task 16 checkpoint.
- Produces: nothing.

`60-dns-override.yaml` exists solely to arbitrate between two simultaneous resolvers. With one adapter active at a time there is never more than one, so it deletes outright rather than shrinking.

- [ ] **Step 1: Delete the three template files**

```bash
git rm templates/vm-shared/pre-scripts/dnsmasq-stub.conf \
       templates/vm-shared/pre-scripts/configamatron-egress.service \
       templates/vm-shared/pre-scripts/60-dns-override.yaml
```

- [ ] **Step 2: Strip the network half of the guest script**

In `templates/vm-shared/pre-scripts/nn-configure-network.sh`, delete everything from the `## --- Persistence: dnsmasq + egress + netplan DNS override ---` header (line 57) to the end of the file, and replace it with:

```bash
## --- Networking ---

# Nothing to do. The adapter stays on DHCP for both networks: on the Default Switch
# it leases from Hyper-V's ICS, and on configamatron-internal it leases from
# run-proxy, which supplies the host as both router (option 3) and DNS (option 6).
#
# Deleted along with this section: the dnsmasq stub (names now resolve to the host,
# not a placeholder), the iptables DNAT rules for 80/443 (nothing needs redirecting
# once names already point at the proxy), the guarded default-route install (the
# route arrives via DHCP), and the netplan DNS override with its DHCP-DNS
# suppression (only one resolver is ever present now).

echo "05-configure-network: CA trusted; addressing and DNS come from the host via DHCP"
```

- [ ] **Step 3: Update the guest verify script**

In `templates/vm-shared/verify-config.sh`, replace the DNAT-rule, dnsmasq-service, and placeholder-resolution checks with:

```bash
# Names must resolve to the host, not to a placeholder.
resolved="$(getent hosts example.com | awk '{print $1}' | head -n1)"
if [ "$resolved" = "$host_ip" ]; then
  pass "names resolve to the host ($resolved)"
else
  fail "names resolve to the host" "example.com -> '${resolved:-<none>}', expected $host_ip"
fi

# The DNAT layer is gone; any NAT rule here is a leftover.
if ! sudo iptables -t nat -S OUTPUT 2>/dev/null | grep -q DNAT; then
  pass "no DNAT rules (traffic goes straight to the proxy)"
else
  fail "no DNAT rules" "$(sudo iptables -t nat -S OUTPUT | grep DNAT)"
fi

# dnsmasq must not be installed in the guest any more.
if ! systemctl is-active --quiet dnsmasq 2>/dev/null; then
  pass "no in-guest dnsmasq (DNS is served by the host)"
else
  fail "no in-guest dnsmasq" "dnsmasq is still active -- remove it"
fi
```

- [ ] **Step 4: Remove the stale template assertions**

In `tests/unit/templates.test.ts`, delete assertions covering `60-dns-override.yaml` (the `use-dns: false` and NetworkManager passthrough checks), `dnsmasq-stub.conf`, and `configamatron-egress.service`. Keep every other assertion.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A templates/vm-shared tests/unit/templates.test.ts
git commit -m "feat: remove the in-guest Ubuntu DNS, DNAT and route layer"
```

---

### Task 18: Rework the VM test harness

**Files:**

- Modify: `tests/vm/harness/net.sh:22-50`
- Modify: `tests/vm/vm.test.ts` (lines 111-126, 198, 403-408)
- Modify: `tests/vm/harness/guest.sh:86` (journal collection)

**Interfaces:**

- Consumes: nothing from earlier tasks — this layer deliberately does **not** exercise the production TypeScript servers.
- Produces: nothing.

**Keep `dnsmasq` running in the harness.** `guest.sh:7-11` derives every guest's SSH address by looking up its MAC in `$RUN/dnsmasq.leases`; that lease file is the control channel for every `gexec` call. Running the production servers inside WSL would test Windows-targeted code on Linux — whose specific-IP broadcast binding differs — and still would not exercise Windows Firewall. This layer verifies the **guest-side simplification** only.

- [ ] **Step 1: Make the gateway-less mode behave like the host services**

In `tests/vm/harness/net.sh`, in the `hostonly` branch of the `dhcp` case, replace the "suppress router and DNS" options with options that mirror what `run-proxy` serves:

```bash
        # Mirror what run-proxy's DHCP server hands out on the isolated network:
        # the host is both router and DNS. (Production DHCP/DNS is the TypeScript
        # code on Windows; dnsmasq stands in for it here so this layer can focus on
        # guest-side behaviour, and so guest.sh keeps its lease-file control channel.)
        echo "dhcp-option=option:router,$BRIDGE_IP"
        echo "dhcp-option=option:dns-server,$BRIDGE_IP"
        # Catch-all A answers, exactly like the host responder.
        echo "address=/#/$BRIDGE_IP"
```

- [ ] **Step 2: Replace the in-guest DNS assertions**

In `tests/vm/vm.test.ts`, replace the test at lines 111-121 with:

```ts
  it('resolves every name to the host, answered by the host resolver', async () => {
    const { stdout } = await guest('g1', 'getent hosts example.com');
    expect(stdout.trim().split(/\s+/)[0]).toBe(BRIDGE_IP);

    const { stdout: dns } = await guest('g1', 'resolvectl dns');
    expect(dns).toContain(BRIDGE_IP);
  });
```

- [ ] **Step 3: Replace the DNAT assertions**

Replace the test at lines 123-126 with:

```ts
  it('installs no DNAT rules', async () => {
    const { stdout } = await guest('g1', 'sudo iptables -t nat -S OUTPUT');
    expect(stdout).not.toContain('DNAT');
  });
```

Apply the same replacement to the `g2` assertions at lines 403-405, and replace the `dig +short example.com @127.0.0.1` check at 407-408 with:

```ts
    const dns = await guest('g2', 'getent hosts example.com');
    expect(dns.stdout.trim().split(/\s+/)[0]).toBe(BRIDGE_IP);
```

- [ ] **Step 4: Replace the dnsmasq service assertion**

Replace line 198 with:

```ts
    expect((await guest('g1', 'systemctl is-active dnsmasq || true')).stdout.trim()).not.toBe(
      'active',
    );
```

- [ ] **Step 5: Fix the journal collection**

In `tests/vm/harness/guest.sh:86`, remove the now-deleted units:

```bash
    gexec "$name" 'sudo journalctl -u systemd-networkd -u systemd-resolved --no-pager' > "$out/journal.txt" 2>&1 || true
```

- [ ] **Step 6: Run the VM suite**

Run: `pnpm test:vm`
Expected: PASS. This is the longest-running suite and the most likely to need iteration; if a guest cannot be reached, check `$RUN/dnsmasq.leases` is still being written before assuming a test-logic problem.

- [ ] **Step 7: Commit**

```bash
git add tests/vm
git commit -m "test: model the host-resolver topology in the VM harness"
```

---

### Task 19: Ubuntu guest documentation and manual checkpoint

**Files:**

- Modify: `usage-hyper-v.md` (Ubuntu guest section, around lines 158-191)

**Interfaces:**

- Consumes: everything from Phases 1-5.
- Produces: the Ubuntu checkpoint result.

- [ ] **Step 1: Replace the Ubuntu static-IP instructions**

Replace the netplan static-IP block (around lines 162-175) with:

```markdown
**Ubuntu guest** — leave the interface on **DHCP**; the installer's default
configuration is already correct and no netplan drop-in is needed. On the Default
Switch it leases from Hyper-V's ICS; on `configamatron-internal` it leases from
`run-proxy`, which supplies the host as both router and DNS.

Mount the share (use the Default Switch host IP during the NAT phase, the
Internal-switch host IP afterwards):

```bash
sudo mkdir -p /mnt/vm-shared
echo '//<host-ip>/vm-shared  /mnt/vm-shared  cifs  ro,credentials=/etc/configamatron-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount  0  0' | sudo tee -a /etc/fstab
sudo mount -a
```
```

- [ ] **Step 2: Note the recovery path**

Add after that block:

```markdown
> **If a guest ever comes up with no address**, `run-proxy` was not running when it
> booted. Start `run-proxy` and the guest will pick up a lease on its next retry.
> As a last resort, the Hyper-V console plus a static address (an IP in the
> Internal-switch subnet, no gateway, `nameserver = <host-ip>`) still works and is
> a supported fallback.
```

- [ ] **Step 3: Verify formatting**

Run: `pnpm format:check`
Expected: PASS.

- [ ] **Step 4: Manual checkpoint on a real Ubuntu guest**

Full flow: guest on Default Switch → numbered scripts → shut down → reassign to `configamatron-internal` → boot with `run-proxy` running.

Verify in the guest:

```bash
ip -4 addr                        # address in the pool
ip -4 route show default          # default via <host-ip>
resolvectl status                 # DNS = <host-ip>, and only that
getent hosts example.com          # -> <host-ip>
sudo iptables -t nat -S OUTPUT    # no DNAT rules
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com
sudo apt-get update
bash /mnt/vm-shared/verify-config.sh <host-ip>
```

Expected: an address from the pool, the host as default route and sole resolver, names resolving to the host, no NAT rules, `curl` returning an HTTP status, `apt-get update` succeeding, and `verify-config.sh` reporting no failures.

- [ ] **Step 5: Record the result and commit**

```bash
git add usage-hyper-v.md docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md
git commit -m "docs: single-adapter DHCP flow for the Ubuntu guest"
```

---

# PHASE 6 — Remaining documentation

### Task 20: README, technical notes, and investigation closure

**Files:**

- Modify: `README.md`
- Modify: `technical-notes.md`
- Modify: `docs/investigations/2026-07-22-host-side-dns-consolidation.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Update `README.md`**

Find and replace any guest-network description referencing the DNAT/stub model:

```bash
grep -n "dnsmasq\|DNAT\|placeholder\|203.0.113\|dns-stub\|host-only" README.md
```

Replace each with the current model: guests are DHCP-configured and receive their address, default route, and resolver from `run-proxy` on the host; every name resolves to the host proxy.

- [ ] **Step 2: Rewrite the guest-networking section of `technical-notes.md`**

Replace the "VM networking details" and "VM egress" sections with:

```markdown
### VM networking

Guests run **DHCP only**. `run-proxy` serves both DHCP and DNS on the Hyper-V
Internal-switch adapter IP:

- **DHCP** hands out an address from an in-memory lease table, with the host as
  both router (option 3) and DNS (option 6).
- **DNS** answers every A query with the host IP, and every other qtype with
  NOERROR and no answer records so callers fall back to A.

Because names already resolve to the host, guests connect straight to the proxy
with SNI intact. There is no DNAT layer, no in-guest resolver, and no
default-route hack — all three were deleted when DNS moved to the host.

Both services bind the **specific** adapter address rather than a wildcard. On
Windows this coexists with the ICS service's wildcard `0.0.0.0:53`, and the more
specific bind wins packet delivery; it also scopes each service to the network it
owns. See `docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`.

Switching a guest between the isolated and NAT networks is a host-side adapter
reassignment (`Connect-VMNetworkAdapter -SwitchName`) with **no guest-side change**:
on the Default Switch it simply leases from Hyper-V's ICS instead.
```

- [ ] **Step 3: Update the testing fidelity-gaps paragraph**

Replace it with:

```markdown
Testing runs in three layers. Unit tests exercise the real DNS and DHCP modules as
byte arrays, covering the protocol grammar, the RFC 2131 state table, and the lease
table. The WSL/QEMU harness (`pnpm test:vm`) keeps `dnsmasq` as a stand-in for the
host services and verifies **guest-side** behaviour only — that a DHCP-only guest
with no in-guest resolver and no DNAT rules reaches the proxy. It deliberately does
not exercise the production servers: they are written for Windows semantics, and
running them under WSL would test the wrong platform while still missing Windows
Firewall. That leaves Windows binding, firewall scoping, and real DHCP client
interop to the manual Hyper-V checkpoints.
```

- [ ] **Step 4: Close the investigation**

At the top of `docs/investigations/2026-07-22-host-side-dns-consolidation.md`, change the status line to:

```markdown
**Status:** Resolved. The blocking question — whether the host can bind
`<host-ip>:53` alongside a wildcard holder — was answered affirmatively; see
`docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`. The design
that followed is
`docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`, which was
implemented and additionally moved DHCP to the host.
```

- [ ] **Step 5: Final full verification**

Run: `pnpm test && pnpm test:vm`
Expected: PASS.

Then confirm nothing live still references the deleted machinery:

```bash
grep -rn "dnsmasq-stub\|configamatron-egress\|60-dns-override\|ConfigamatronDnsResponder\|isDnsResponderBuildArtifact" \
  --include=*.ts --include=*.ps1 --include=*.sh --include=*.md --include=*.yaml . \
  | grep -v node_modules | grep -v "docs/superpowers/" | grep -v "docs/honist-v/" \
  | grep -v "docs/investigations/" | grep -v "legacy/"
```

Expected: no output. (`dnsmasq` alone still appears legitimately in `tests/vm/harness/` — it remains the harness stand-in.)

- [ ] **Step 6: Commit**

```bash
git add README.md technical-notes.md docs/investigations/2026-07-22-host-side-dns-consolidation.md
git commit -m "docs: describe the host-served DNS and DHCP model"
```

---

## Self-Review

**Spec coverage.** Decision 1 → Tasks 1-2, 4. Decision 2 (wire semantics, tightened grammar) → Task 1. Decision 3 (bind/lifecycle, all-or-nothing) → Tasks 3-4, 12. Decision 4 (one adapter) → Tasks 13, 15, 19. Decision 5 (DHCP, lease table, protocol states) → Tasks 6-12. Decision 6 (share on NAT) → Task 13. Decision 7 (host readiness, recovery) → Tasks 13, 16, 19. Decision 8 (firewall, verify) → Tasks 5, 12. Test layers 1/2/3 → Tasks 1-12 / 18 / 16, 19. A6 → Task 16.

**Two spec items deliberately not given their own task:** the adapter-IP-disappears-while-running fatal exit (decision 3) is not implemented — Node's `dgram` gives no address-change event, so detecting it needs polling that the failure frequency does not justify. The symptom is covered by `verify-proxy.ps1`'s listener checks. Flag at execution time if the reviewer disagrees. The "validate the local address each packet arrived on" requirement (decision 5) is satisfied structurally by the specific-address bind rather than a runtime check — documented in the `DhcpServerOptions` comment in Task 10.

**Type consistency.** `DnsResponderHandle`/`DhcpServerHandle` both expose `port` and `close()`, satisfying `Closable` in Task 3. `LeaseTable.request` returns `'ack' | 'nak'` and is called only in Task 9. `handleDhcp` returns `DhcpReply | null`, consumed only in Task 10. `resolveInternalSwitchNetwork` returns `{ address, netmask }`, consumed in Task 12. `parsePacket` returns `DhcpPacket | null` and `parseQuery` returns the tagged `ParseResult` — the two differ by design, since DNS distinguishes drop from FORMERR while DHCP only ever drops.

**Placeholder scan.** No TBD/TODO. Every code step carries complete code. Task 14 step 1 and Task 20 step 1 use `grep` to enumerate call sites rather than naming files I have not read — the commands are exact and their expected output is described.

---

**Plan complete and saved to `docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md`. Consider clearing context before executing the plan.**
