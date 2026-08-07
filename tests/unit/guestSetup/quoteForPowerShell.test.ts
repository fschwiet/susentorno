import { describe, it, expect } from 'vitest';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

describe('quoteForPowerShell', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteForPowerShell('temp-vm')).toBe("'temp-vm'");
  });

  it('doubles an embedded single quote', () => {
    expect(quoteForPowerShell("O'Brien")).toBe("'O''Brien'");
  });

  it('doubles multiple embedded single quotes', () => {
    expect(quoteForPowerShell("a'b'c")).toBe("'a''b''c'");
  });

  it('leaves other PowerShell-significant characters untouched, since single-quoting neutralizes them', () => {
    expect(quoteForPowerShell('a; Remove-Item x $var `id` & | > <')).toBe(
      "'a; Remove-Item x $var `id` & | > <'",
    );
  });

  it('handles an empty string', () => {
    expect(quoteForPowerShell('')).toBe("''");
  });
});
