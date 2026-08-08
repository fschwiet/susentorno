import { createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import forge from 'node-forge';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
  receivedUpgradeAuthorizationHeaders: string[];
  /** Full headers object for every request, in order — for asserting on headers
   * other than Authorization (e.g. that no internal marker header ever leaks). */
  receivedHeaders: IncomingHttpHeaders[];
  /** Same as receivedHeaders, but for WebSocket upgrade requests. */
  receivedUpgradeHeaders: IncomingHttpHeaders[];
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'mock-upstream' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

export function startMockUpstream(): Promise<MockUpstream> {
  const pems = generateSelfSignedCert();
  const receivedAuthorizationHeaders: string[] = [];
  const receivedHeaders: IncomingHttpHeaders[] = [];

  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  const receivedUpgradeAuthorizationHeaders: string[] = [];
  const receivedUpgradeHeaders: IncomingHttpHeaders[] = [];
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedUpgradeHeaders.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolve({
        port: address.port,
        server,
        receivedAuthorizationHeaders,
        receivedUpgradeAuthorizationHeaders,
        receivedHeaders,
        receivedUpgradeHeaders,
      });
    });
  });
}

export function stopMockUpstream(mock: MockUpstream): Promise<void> {
  return new Promise((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}
