import { describe, it, expect } from 'vitest';
import { quoteForRemoteShell } from '../../../src/guestSetup/quoteForRemoteShell';

describe('quoteForRemoteShell', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteForRemoteShell('vm-shared-linux')).toBe("'vm-shared-linux'");
  });

  it('escapes an embedded single quote', () => {
    expect(quoteForRemoteShell("O'Brien")).toBe("'O'\\''Brien'");
  });

  it('escapes multiple embedded single quotes', () => {
    expect(quoteForRemoteShell("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('leaves other shell metacharacters untouched, since single-quoting neutralizes them', () => {
    expect(quoteForRemoteShell('a; rm -rf / $(whoami) `id` & | > <')).toBe(
      "'a; rm -rf / $(whoami) `id` & | > <'",
    );
  });

  it('handles an empty string', () => {
    expect(quoteForRemoteShell('')).toBe("''");
  });
});
