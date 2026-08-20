import { describe, expect, it } from 'vitest';
import {
  AnswerFileIsoError,
  buildAnswerIsoCommand,
  writeAnswerFileIso,
} from '../../guest/hyperv/answerFileIso';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

describe('buildAnswerIsoCommand', () => {
  const command = buildAnswerIsoCommand('C:\\cache\\answer.iso', '<unattend/>');

  it('uses the built-in IMAPI2FS COM component, not an external ISO writer', () => {
    expect(command).toContain('IMAPI2FS.MsftFileSystemImage');
    expect(command).toContain('CreateResultImage');
    expect(command).not.toContain('oscdimg');
  });

  it('copies the result IStream block by block through a compiled helper', () => {
    expect(command).toContain('SusentornoIsoWriter');
    expect(command).toContain('TotalBlocks');
    expect(command).toContain('BlockSize');
  });

  it('names the file Autounattend.xml at the image root', () => {
    expect(command).toContain('Autounattend.xml');
  });

  it('carries the XML as base64 so no quoting can corrupt it', () => {
    expect(command).toContain(Buffer.from('<unattend/>', 'utf8').toString('base64'));
    expect(command).not.toContain('<unattend/>');
  });

  it('single-quotes the destination path PowerShell-style', () => {
    expect(buildAnswerIsoCommand("C:\\it's\\a.iso", 'x')).toContain("'C:\\it''s\\a.iso'");
  });

  it('adds extra files to the same image root alongside Autounattend.xml', () => {
    // The FirstLogonCommands base64-inline approach hit unattend.xml's
    // ~4096-character CommandLine limit (confirmed live: Setup rejected the
    // whole answer file with "Value is invalid" once the provisioning script
    // grew past it). Shipping the script as a file on this same ISO, fetched
    // by a short Copy-Item, sidesteps the limit entirely.
    const withExtra = buildAnswerIsoCommand('C:\\cache\\answer.iso', '<unattend/>', {
      'susentorno-provision.ps1': 'Write-Host hi',
    });
    expect(withExtra).toContain('susentorno-provision.ps1');
    expect(withExtra).toContain(Buffer.from('Write-Host hi', 'utf8').toString('base64'));
    expect(withExtra).toContain('AddFile');
  });
});

describe('writeAnswerFileIso', () => {
  it('throws a typed error carrying the PowerShell output', async () => {
    const exec: PowerShellExec = {
      run: async () => ({ exitCode: 1, stdout: 'COM exception 0x80070005' }),
    };
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).rejects.toThrow(AnswerFileIsoError);
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).rejects.toThrow(
      /COM exception 0x80070005/,
    );
  });

  it('resolves silently on success', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: '' }) };
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).resolves.toBeUndefined();
  });
});
