import { describe, it, expect } from 'vitest';
import { delimiter } from 'node:path';
import {
  buildInstallExtraCaCommand,
  extraCaFileName,
  parseExtraCaPaths,
} from '../../guest/extraCas';

describe('parseExtraCaPaths', () => {
  it('treats unset as "this machine is not intercepted"', () => {
    expect(parseExtraCaPaths(undefined)).toEqual([]);
    expect(parseExtraCaPaths('')).toEqual([]);
  });

  it('takes a single path', () => {
    expect(parseExtraCaPaths('C:\\ca\\outer.pem')).toEqual(['C:\\ca\\outer.pem']);
  });

  it('splits on the platform path delimiter, so a PATH-shaped value works', () => {
    expect(parseExtraCaPaths(['/a/one.pem', '/b/two.pem'].join(delimiter))).toEqual([
      '/a/one.pem',
      '/b/two.pem',
    ]);
  });

  it('drops empty segments and surrounding whitespace', () => {
    expect(parseExtraCaPaths([' /a/one.pem ', '', '/b/two.pem'].join(delimiter))).toEqual([
      '/a/one.pem',
      '/b/two.pem',
    ]);
  });
});

describe('extraCaFileName', () => {
  it('renames to .crt, which is the only extension update-ca-certificates reads', () => {
    expect(extraCaFileName('C:\\ca\\outer-proxy.pem')).toBe('outer-proxy.crt');
  });

  it('keeps a name that is already .crt', () => {
    expect(extraCaFileName('/etc/ssl/outer.crt')).toBe('outer.crt');
  });

  it('adds .crt when there is no extension at all', () => {
    expect(extraCaFileName('/etc/ssl/outer')).toBe('outer.crt');
  });

  it('replaces characters that would need shell quoting in the destination path', () => {
    expect(extraCaFileName("/ca/o'brien ca.pem")).toBe('o-brien-ca.crt');
  });
});

describe('buildInstallExtraCaCommand', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const command = buildInstallExtraCaCommand('outer.crt', pem);

  it('writes into the system trust anchor directory', () => {
    expect(command).toContain('sudo tee /usr/local/share/ca-certificates/outer.crt');
    expect(command).toContain('sudo chmod 644 /usr/local/share/ca-certificates/outer.crt');
  });

  it('carries the PEM as base64, which cannot break out of the shell quoting', () => {
    expect(command).toContain(`printf %s '${Buffer.from(pem, 'utf8').toString('base64')}'`);
    expect(command).toContain('base64 -d');
    expect(command).not.toContain('BEGIN CERTIFICATE');
  });

  it("does not set NODE_EXTRA_CA_CERTS — that is configure-network's single-file slot", () => {
    expect(command).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('chains with && so a failed write does not report success', () => {
    expect(command).toContain('&&');
  });
});
