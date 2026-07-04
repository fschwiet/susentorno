#!/usr/bin/env node
// Static DNS responder for the sandbox VM's own resolver.
//
// The VM's systemd-resolved forwards upstream queries to 127.0.0.1 (see the
// netplan override installed by vm-setup-persistence.sh), where this stub
// answers. This isn't a real resolver: the actual destination IP for
// tcp/80 and tcp/443 is discarded by the VM's iptables DNAT rules (which
// redirect by port only, to Envoy) and Envoy re-resolves the real hostname
// itself before connecting upstream. So every A-record query just gets
// back the same fixed placeholder address - its only job is to let the
// querying process's DNS lookup succeed so it proceeds to attempt the
// (redirected) connection at all.
//
// Usage: node dns-stub.js [placeholder-ip]

import dgram from "node:dgram";

const bindIp = "127.0.0.1";
const placeholderIp = process.argv[2] || "203.0.113.1";

const placeholderBytes = placeholderIp.split(".").map((n) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    throw new Error(`invalid placeholder IP: ${placeholderIp}`);
  }
  return v;
});

function parseQuestion(msg) {
  let offset = 12;
  const labels = [];
  while (true) {
    const len = msg[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    labels.push(msg.toString("ascii", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  const qtype = msg.readUInt16BE(offset);
  const qclass = msg.readUInt16BE(offset + 2);
  const questionEnd = offset + 4;
  return {
    name: labels.join("."),
    qtype,
    qclass,
    questionBytes: msg.subarray(12, questionEnd),
  };
}

function buildResponse(msg, question) {
  const isA = question.qtype === 1 && question.qclass === 1;
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // echo the query ID
  header.writeUInt16BE(0x8180, 2); // standard response, no error
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(isA ? 1 : 0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  if (!isA) {
    return Buffer.concat([header, question.questionBytes]);
  }

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // pointer to question name at offset 12
  answer.writeUInt16BE(1, 2); // TYPE A
  answer.writeUInt16BE(1, 4); // CLASS IN
  answer.writeUInt32BE(300, 6); // TTL
  answer.writeUInt16BE(4, 10); // RDLENGTH
  Buffer.from(placeholderBytes).copy(answer, 12);

  return Buffer.concat([header, question.questionBytes, answer]);
}

const socket = dgram.createSocket("udp4");

socket.on("message", (msg, rinfo) => {
  let question;
  try {
    question = parseQuestion(msg);
  } catch (err) {
    console.error(`dns-stub: failed to parse query from ${rinfo.address}:${rinfo.port}: ${err.message}`);
    return;
  }
  console.log(`dns-stub: ${rinfo.address} asked for ${question.name} (type ${question.qtype}) -> ${question.qtype === 1 ? placeholderIp : "empty"}`);
  socket.send(buildResponse(msg, question), rinfo.port, rinfo.address);
});

socket.on("error", (err) => {
  console.error(`dns-stub: socket error: ${err.message}`);
  process.exit(1);
});

socket.bind(53, bindIp, () => {
  console.log(`dns-stub: listening on ${bindIp}:53, answering A queries with ${placeholderIp}`);
});
