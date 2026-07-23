import { describe, it, expect } from 'vitest';
import { parseQuery, buildResponse, buildFormErr, answerFor } from '../../../src/runProxy/dnsMessage';

function query(name: string, qtype = 1, qclass = 1, opts: { id?: number; rd?: boolean; qdcount?: number; qr?: boolean; opcode?: number } = {}): Buffer {
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
  for (const l of labels) { buf.writeUInt8(l.length, off++); buf.write(l, off, 'ascii'); off += l.length; }
  buf.writeUInt8(0, off++); buf.writeUInt16BE(qtype, off); buf.writeUInt16BE(qclass, off + 2);
  return buf;
}

describe('parseQuery', () => {
  it('parses a well-formed A query', () => { const r = parseQuery(query('api.anthropic.com')); expect(r.kind).toBe('ok'); if (r.kind !== 'ok') return; expect(r.query.name).toBe('api.anthropic.com'); expect(r.query.qtype).toBe(1); expect(r.query.id).toBe(0x1234); expect(r.query.rd).toBe(true); });
  it('lowercases the name', () => { const r = parseQuery(query('API.Anthropic.COM')); expect(r.kind === 'ok' && r.query.name).toBe('api.anthropic.com'); });
  it('drops packets shorter than a 12-byte header', () => { expect(parseQuery(Buffer.alloc(11)).kind).toBe('drop'); });
  it('drops responses (QR=1) so replies cannot loop', () => { expect(parseQuery(query('a.test', 1, 1, { qr: true })).kind).toBe('drop'); });
  it('rejects a non-QUERY opcode with FORMERR', () => { expect(parseQuery(query('a.test', 1, 1, { opcode: 2 })).kind).toBe('formerr'); });
  it('rejects QDCOUNT other than 1 with FORMERR', () => { expect(parseQuery(query('a.test', 1, 1, { qdcount: 2 })).kind).toBe('formerr'); });
  it('rejects a non-IN class with FORMERR', () => { expect(parseQuery(query('a.test', 1, 3)).kind).toBe('formerr'); });
  it('rejects a compression pointer in the question with FORMERR', () => { const buf = Buffer.alloc(16); buf.writeUInt16BE(0x1234, 0); buf.writeUInt16BE(0x0100, 2); buf.writeUInt16BE(1, 4); buf.writeUInt8(0xc0, 12); buf.writeUInt8(0x0c, 13); expect(parseQuery(buf).kind).toBe('formerr'); });
  it('rejects a label running past the end of the buffer', () => { const buf = Buffer.alloc(16); buf.writeUInt16BE(0x1234, 0); buf.writeUInt16BE(0x0100, 2); buf.writeUInt16BE(1, 4); buf.writeUInt8(60, 12); expect(parseQuery(buf).kind).toBe('formerr'); });
});

describe('answerFor', () => {
  it('answers A with the host IP', () => { expect(answerFor('anything.test', 1, '192.168.67.1')).toBe('192.168.67.1'); });
  it('returns null for AAAA so the response carries no answer records', () => { expect(answerFor('anything.test', 28, '192.168.67.1')).toBeNull(); });
  it('returns null for other qtypes', () => { for (const qtype of [2, 5, 15, 16, 33]) expect(answerFor('anything.test', qtype, '192.168.67.1')).toBeNull(); });
});

describe('buildResponse', () => {
  it('answers an A query with the host IP, TTL 30', () => { const q = query('api.anthropic.com'); const parsed = parseQuery(q); if (parsed.kind !== 'ok') throw new Error('setup'); const r = buildResponse(q, parsed.query, '192.168.67.1'); expect(r.readUInt16BE(0)).toBe(0x1234); expect(r.readUInt16BE(2) & 0x8000).toBe(0x8000); expect(r.readUInt16BE(2) & 0x0100).toBe(0x0100); expect(r.readUInt16BE(2) & 0x0080).toBe(0); expect(r.readUInt16BE(2) & 0x000f).toBe(0); expect(r.readUInt16BE(4)).toBe(1); expect(r.readUInt16BE(6)).toBe(1); expect(r.readUInt16BE(8)).toBe(0); expect(r.readUInt16BE(10)).toBe(0); const ansOff = parsed.query.questionEnd; expect(r.readUInt16BE(ansOff)).toBe(0xc00c); expect(r.readUInt16BE(ansOff + 2)).toBe(1); expect(r.readUInt16BE(ansOff + 4)).toBe(1); expect(r.readUInt32BE(ansOff + 6)).toBe(30); expect(r.readUInt16BE(ansOff + 10)).toBe(4); expect([...r.subarray(ansOff + 12, ansOff + 16)]).toEqual([192, 168, 67, 1]); });
  it('clears RD when the query did not set it', () => { const q = query('a.test', 1, 1, { rd: false }); const parsed = parseQuery(q); if (parsed.kind !== 'ok') throw new Error('setup'); const r = buildResponse(q, parsed.query, '192.168.67.1'); expect(r.readUInt16BE(2) & 0x0100).toBe(0); });
  it('returns NOERROR with zero answers when there is no answer IP', () => { const q = query('a.test', 28); const parsed = parseQuery(q); if (parsed.kind !== 'ok') throw new Error('setup'); const r = buildResponse(q, parsed.query, null); expect(r.readUInt16BE(6)).toBe(0); expect(r.readUInt16BE(2) & 0x000f).toBe(0); expect(r.length).toBe(parsed.query.questionEnd); });
  it('echoes the question section byte for byte', () => { const q = query('api.anthropic.com'); const parsed = parseQuery(q); if (parsed.kind !== 'ok') throw new Error('setup'); const r = buildResponse(q, parsed.query, '192.168.67.1'); expect(r.subarray(12, parsed.query.questionEnd)).toEqual(q.subarray(12, parsed.query.questionEnd)); });
});

describe('buildFormErr', () => { it('sets RCODE=1 with all counts zero and does not echo request counts', () => { const r = buildFormErr(0xbeef); expect(r.length).toBe(12); expect(r.readUInt16BE(0)).toBe(0xbeef); expect(r.readUInt16BE(2) & 0x8000).toBe(0x8000); expect(r.readUInt16BE(2) & 0x000f).toBe(1); expect(r.readUInt16BE(4)).toBe(0); expect(r.readUInt16BE(6)).toBe(0); }); });
