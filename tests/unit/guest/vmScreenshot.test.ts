import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildThumbnailCommand,
  rgb565ToBmp,
  SCREENSHOT_HEIGHT,
  SCREENSHOT_RETAIN,
  SCREENSHOT_WIDTH,
  startScreenshotCapture,
} from '../../guest/hyperv/vmScreenshot';

describe('rgb565ToBmp', () => {
  it('emits a well-formed 24-bit BMP header for the given dimensions', () => {
    const pixels = Buffer.alloc(2 * 2 * 2);
    const bmp = rgb565ToBmp(pixels, 2, 2);
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readUInt32LE(14)).toBe(40);
    expect(bmp.readInt32LE(18)).toBe(2);
    expect(bmp.readInt32LE(22)).toBe(2);
    expect(bmp.readUInt16LE(28)).toBe(24);
  });

  it('pads each row to a four-byte boundary', () => {
    // 3 px * 3 bytes = 9, padded to 12; 2 rows => 24 bytes of pixel data.
    const bmp = rgb565ToBmp(Buffer.alloc(3 * 2 * 2), 3, 2);
    expect(bmp.length).toBe(54 + 24);
  });

  it('expands RGB565 to BGR with the bottom row first', () => {
    // Row 0 pure red (0xF800), row 1 pure blue (0x001F).
    const pixels = Buffer.alloc(4);
    pixels.writeUInt16LE(0xf800, 0);
    pixels.writeUInt16LE(0x001f, 2);
    const bmp = rgb565ToBmp(pixels, 1, 2);
    // BMP stores bottom-up, so the first stored row is source row 1 (blue).
    expect([bmp[54], bmp[55], bmp[56]]).toEqual([255, 0, 0]);
    expect([bmp[58], bmp[59], bmp[60]]).toEqual([0, 0, 255]);
  });

  it('rejects a buffer that does not match the dimensions', () => {
    expect(() => rgb565ToBmp(Buffer.alloc(6), 2, 2)).toThrow(/expected 8 bytes/);
  });
});

describe('buildThumbnailCommand', () => {
  const command = buildThumbnailCommand('susentorno-test-golden-build', 320, 240);

  it('calls the Hyper-V management service thumbnail method', () => {
    expect(command).toContain('Msvm_VirtualSystemManagementService');
    expect(command).toContain('GetVirtualSystemThumbnailImage');
  });

  it('quotes the VM name and returns base64 for transport', () => {
    expect(command).toContain("'susentorno-test-golden-build'");
    expect(command).toContain('ToBase64String');
  });
});

describe('capture constants', () => {
  it('documents the thumbnail ceiling and the retention window', () => {
    expect(SCREENSHOT_WIDTH).toBe(320);
    expect(SCREENSHOT_HEIGHT).toBe(240);
    expect(SCREENSHOT_RETAIN).toBe(10);
  });
});

describe('startScreenshotCapture', () => {
  it('tolerates the extra 4 bytes GetVirtualSystemThumbnailImage returns beyond width*height*2', async () => {
    const expectedBytes = SCREENSHOT_WIDTH * SCREENSHOT_HEIGHT * 2;
    const raw = Buffer.alloc(expectedBytes + 4);
    const exec: PowerShellExec = {
      run: async () => ({ exitCode: 0, stdout: raw.toString('base64') }),
    };
    const dir = mkdtempSync(join(tmpdir(), 'vm-screenshot-'));
    try {
      const handle = startScreenshotCapture(exec, 'vm', dir, { intervalMs: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await handle.stop();
      expect(readdirSync(dir).filter((name) => name.endsWith('.bmp'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
