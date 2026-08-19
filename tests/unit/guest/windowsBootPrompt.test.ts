import { describe, expect, it } from 'vitest';
import { buildDefeatCdBootPromptCommand } from '../../guest/hyperv/windowsBootPrompt';

describe('buildDefeatCdBootPromptCommand', () => {
  it("resolves the VM's synthetic keyboard and repeatedly types a space", () => {
    const command = buildDefeatCdBootPromptCommand('vm-1', 20);
    expect(command).toContain('Msvm_Keyboard');
    expect(command).toContain('TypeText');
    expect(command).toContain("'vm-1'");
    expect(command).toContain('AsciiText');
  });

  it('quotes the VM name PowerShell-style', () => {
    const command = buildDefeatCdBootPromptCommand("vm's", 5);
    expect(command).toContain("vm''s");
  });

  it('loops for the requested duration', () => {
    const command = buildDefeatCdBootPromptCommand('vm', 25);
    expect(command).toContain('AddSeconds(25)');
  });

  it('stops early once the VM is no longer running, rather than blocking for the full duration', () => {
    // The duration is generous (covers a whole 60-120 minute build), so the
    // loop must exit as soon as the VM powers off -- otherwise a caller
    // awaiting this command after a successful build would hang for however
    // much of the duration remained.
    const command = buildDefeatCdBootPromptCommand('vm', 7200);
    expect(command).toContain('Get-VM');
    expect(command).toMatch(/-ne\s+'?Running'?|!=\s+'?Running'?/);
    expect(command).toContain('break');
  });
});
