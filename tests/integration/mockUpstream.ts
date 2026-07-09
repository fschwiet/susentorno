import { createServer, type Server } from 'node:https';
import forge from 'node-forge';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
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

  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
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
