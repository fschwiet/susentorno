const HEADER_LEN = 12;
const TTL_SECONDS = 30;
const QTYPE_A = 1;
const QCLASS_IN = 1;
const MAX_NAME_LEN = 255;
const MAX_LABEL_LEN = 63;

export interface ParsedQuery { id: number; rd: boolean; name: string; qtype: number; questionEnd: number; }
export type ParseResult = { kind: 'ok'; query: ParsedQuery } | { kind: 'drop'; reason: string } | { kind: 'formerr'; id: number; reason: string };

export function parseQuery(buf: Buffer): ParseResult {
  if (buf.length < HEADER_LEN) return { kind: 'drop', reason: 'short header' };
  const id = buf.readUInt16BE(0); const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return { kind: 'drop', reason: 'QR set' };
  const opcode = (flags >> 11) & 0x0f;
  if (opcode !== 0) return { kind: 'formerr', id, reason: `opcode ${opcode}` };
  const qdcount = buf.readUInt16BE(4);
  if (qdcount !== 1) return { kind: 'formerr', id, reason: `qdcount ${qdcount}` };
  const labels: string[] = []; let off = HEADER_LEN; let nameLen = 0;
  for (;;) {
    if (off >= buf.length) return { kind: 'formerr', id, reason: 'name past end' };
    const len = buf.readUInt8(off);
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) !== 0) return { kind: 'formerr', id, reason: 'compression pointer' };
    if (len > MAX_LABEL_LEN) return { kind: 'formerr', id, reason: 'label too long' };
    if (off + 1 + len > buf.length) return { kind: 'formerr', id, reason: 'label past end' };
    labels.push(buf.toString('ascii', off + 1, off + 1 + len)); nameLen += len + 1;
    if (nameLen > MAX_NAME_LEN) return { kind: 'formerr', id, reason: 'name too long' };
    off += 1 + len;
  }
  if (off + 4 > buf.length) return { kind: 'formerr', id, reason: 'question truncated' };
  const qtype = buf.readUInt16BE(off); const qclass = buf.readUInt16BE(off + 2);
  if (qclass !== QCLASS_IN) return { kind: 'formerr', id, reason: `qclass ${qclass}` };
  return { kind: 'ok', query: { id, rd: (flags & 0x0100) !== 0, name: labels.join('.').toLowerCase(), qtype, questionEnd: off + 4 } };
}

export function answerFor(_name: string, qtype: number, hostIp: string): string | null { return qtype === QTYPE_A ? hostIp : null; }

export function buildResponse(request: Buffer, query: ParsedQuery, answerIp: string | null): Buffer {
  const questionLen = query.questionEnd - HEADER_LEN; const answerLen = answerIp ? 16 : 0;
  const out = Buffer.alloc(HEADER_LEN + questionLen + answerLen);
  out.writeUInt16BE(query.id, 0); out.writeUInt16BE(0x8000 | (query.rd ? 0x0100 : 0), 2);
  out.writeUInt16BE(1, 4); out.writeUInt16BE(answerIp ? 1 : 0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  request.copy(out, HEADER_LEN, HEADER_LEN, query.questionEnd);
  if (answerIp) { let off = query.questionEnd; out.writeUInt16BE(0xc00c, off); out.writeUInt16BE(QTYPE_A, off + 2); out.writeUInt16BE(QCLASS_IN, off + 4); out.writeUInt32BE(TTL_SECONDS, off + 6); out.writeUInt16BE(4, off + 10); off += 12; for (const octet of answerIp.split('.')) out.writeUInt8(Number(octet), off++); }
  return out;
}

export function buildFormErr(id: number): Buffer { const out = Buffer.alloc(HEADER_LEN); out.writeUInt16BE(id, 0); out.writeUInt16BE(0x8001, 2); return out; }
