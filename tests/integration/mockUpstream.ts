import { createServer, type Server } from 'node:https';
import selfsigned from 'selfsigned';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
}

export function startMockUpstream(): Promise<MockUpstream> {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'mock-upstream' }], {
    days: 1,
    keySize: 2048,
  });
  const receivedAuthorizationHeaders: string[] = [];

  const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolve({ port: address.port, server, receivedAuthorizationHeaders });
    });
  });
}

export function stopMockUpstream(mock: MockUpstream): Promise<void> {
  return new Promise((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}
