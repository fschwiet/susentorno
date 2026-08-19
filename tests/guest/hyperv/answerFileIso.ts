import { rmSync } from 'node:fs';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

export class AnswerFileIsoError extends Error {}

/**
 * A one-file ISO carrying Autounattend.xml, attached as the build VM's second
 * DVD drive. A DVD root is unambiguously inside Windows Setup's answer-file
 * search; a SCSI-attached VHDX is not removable and is not clearly searched.
 *
 * IMAPI2FS ships with Windows, so this reintroduces none of the Node
 * ISO-writing dependency ADR-0025 rejected. The XML crosses as base64 for the
 * same reason ambientTrust.ts base64s PEMs: its own newlines and quotes cannot
 * survive shell quoting reliably.
 */
export function buildAnswerIsoCommand(isoPath: string, answerXml: string): string {
  const base64 = Buffer.from(answerXml, 'utf8').toString('base64');
  // CreateResultImage() hands back a COM IStream, which PowerShell cannot
  // write to a file on its own. A tiny compiled helper copies it block by
  // block; IMAPI pads every block to BlockSize, so passing IntPtr.Zero for
  // the bytes-read pointer is safe and keeps the helper out of /unsafe.
  const isoWriter = [
    'public class SusentornoIsoWriter {',
    '  public static void Create(string path, object stream, int blockSize, int totalBlocks) {',
    '    var source = stream as System.Runtime.InteropServices.ComTypes.IStream;',
    '    if (source == null) throw new System.ArgumentException("not an IStream");',
    '    var buffer = new byte[blockSize];',
    '    using (var output = System.IO.File.OpenWrite(path)) {',
    '      while (totalBlocks-- > 0) {',
    '        source.Read(buffer, blockSize, System.IntPtr.Zero);',
    '        output.Write(buffer, 0, blockSize);',
    '      }',
    '      output.Flush();',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quoteForPowerShell(base64)}))`,
    '$payload = New-Object -ComObject ADODB.Stream',
    '$payload.Open(); $payload.Type = 1',
    '$payload.Write([Text.Encoding]::UTF8.GetBytes($source)); $payload.Position = 0',
    '$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage',
    // 3 == ISO9660 + Joliet. Setup reads either; UDF buys nothing for one file.
    '$image.FileSystemsToCreate = 3',
    "$image.VolumeName = 'SUSENTORNO'",
    "$image.Root.AddFile('Autounattend.xml', $payload)",
    '$result = $image.CreateResultImage()',
    `if (-not ('SusentornoIsoWriter' -as [type])) { Add-Type -TypeDefinition ${quoteForPowerShell(isoWriter)} }`,
    `[SusentornoIsoWriter]::Create(${quoteForPowerShell(isoPath)}, $result.ImageStream, $result.BlockSize, $result.TotalBlocks)`,
    '$payload.Close()',
  ].join('; ');
}

export async function writeAnswerFileIso(
  exec: PowerShellExec,
  isoPath: string,
  answerXml: string,
): Promise<void> {
  rmSync(isoPath, { force: true });
  const { exitCode, stdout } = await exec.run(buildAnswerIsoCommand(isoPath, answerXml));
  if (exitCode !== 0) {
    throw new AnswerFileIsoError(
      `answerFileIso: could not build '${isoPath}' (exit ${exitCode}): ${stdout}`,
    );
  }
}
