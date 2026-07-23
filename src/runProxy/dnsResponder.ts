import dgram from 'node:dgram';
import { parseQuery, buildResponse, buildFormErr, answerFor } from './dnsMessage';

export interface DnsResponderOptions {
  listenAddress: string;
  answerIp: string;
  port?: number;
  onError?: (message: string) => void;
}
export interface DnsResponderHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function startDnsResponder(opts: DnsResponderOptions): Promise<DnsResponderHandle> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  socket.on('message', (msg, rinfo) => {
    const parsed = parseQuery(msg);
    if (parsed.kind === 'drop') return;
    const reply =
      parsed.kind === 'formerr'
        ? buildFormErr(parsed.id)
        : buildResponse(
            msg,
            parsed.query,
            answerFor(parsed.query.name, parsed.query.qtype, opts.answerIp),
          );
    socket.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) opts.onError?.(`dns: send to ${rinfo.address}:${rinfo.port} failed: ${err.message}`);
    });
  });
  return new Promise((resolve, reject) => {
    const onBindError = (err: Error) => {
      socket.removeListener('error', onBindError);
      reject(err);
    };
    socket.once('error', onBindError);
    socket.bind(opts.port ?? 53, opts.listenAddress, () => {
      socket.removeListener('error', onBindError);
      socket.on('error', (err) => opts.onError?.(`dns: ${err.message}`));
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((r) => socket.close(() => r())),
      });
    });
  });
}
