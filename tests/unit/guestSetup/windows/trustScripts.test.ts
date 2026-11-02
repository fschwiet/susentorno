import { describe, expect, it } from 'vitest';
import { buildPublishScript } from '../../../../src/guestSetup/windows/trustScripts';

describe('trust scripts: atomic replacement in Windows PowerShell 5.1', () => {
  it('never passes a bare $null as File.Replace backup path', () => {
    // Confirmed live: PowerShell 5.1 turns a bare $null into an empty string for
    // a [string] parameter, and File.Replace then throws "The path is not of a
    // legal form", which broke every replay once the manifest already existed.
    // [NullString]::Value is the only way to pass a real null backup path.
    const script = buildPublishScript({
      manifest: { version: 1, ambient: [], proxy: 'a'.repeat(64) },
      bundlePem: 'PEM',
      proxy: { pem: 'PEM', sha256: 'a'.repeat(64) },
    } as unknown as Parameters<typeof buildPublishScript>[0]);
    expect(script).toContain('[System.IO.File]::Replace(');
    expect(script).toContain('[NullString]::Value');
    expect(script).not.toMatch(/File\]::Replace\([^)]*\$null\)/);
  });
});
