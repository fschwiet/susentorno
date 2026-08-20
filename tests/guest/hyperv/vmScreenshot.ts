import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * Hyper-V's thumbnail capture is capped at a low resolution, so these frames
 * classify state — "at a setup prompt", "installing", "bugcheck", "desktop" —
 * rather than rendering readable text. That is still the difference between
 * knowing which failure mode you are in and knowing nothing, which is what
 * makes iterating on autounattend.xml tractable. Windows Setup writes nothing
 * to serial, so there is no richer channel to prefer.
 */
export const SCREENSHOT_WIDTH = 320;
export const SCREENSHOT_HEIGHT = 240;
export const SCREENSHOT_RETAIN = 10;
const CAPTURE_INTERVAL_MS = 120_000;

/** Raw RGB565, two bytes per pixel, top row first — not an encoded image. */
export function rgb565ToBmp(pixels: Buffer, width: number, height: number): Buffer {
  const expected = width * height * 2;
  if (pixels.length !== expected) {
    throw new Error(`rgb565ToBmp: expected ${expected} bytes, received ${pixels.length}`);
  }
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(54 + pixelBytes, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y++) {
    // BMP rows are stored bottom-up.
    const destinationRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const value = pixels.readUInt16LE((y * width + x) * 2);
      const red = (((value >> 11) & 0x1f) * 255) / 31;
      const green = (((value >> 5) & 0x3f) * 255) / 63;
      const blue = ((value & 0x1f) * 255) / 31;
      const offset = 54 + destinationRow * rowStride + x * 3;
      bmp[offset] = Math.round(blue);
      bmp[offset + 1] = Math.round(green);
      bmp[offset + 2] = Math.round(red);
    }
  }
  return bmp;
}

export function buildThumbnailCommand(vmName: string, width: number, height: number): string {
  const name = quoteForPowerShell(vmName);
  return [
    "$ErrorActionPreference = 'Stop'",
    '$service = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_VirtualSystemManagementService',
    `$vm = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter ("ElementName='" + ${name}.Replace("'","''") + "'")`,
    '$settings = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_VirtualSystemSettingData',
    '$result = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage ' +
      `-Arguments @{ TargetSystem = $settings; WidthPixels = ${width}; HeightPixels = ${height} }`,
    '[Convert]::ToBase64String([byte[]]$result.ImageData)',
  ].join('; ');
}

export interface ScreenshotHandle {
  stop(): Promise<void>;
}

/**
 * Frames land wherever the caller says: the build writes to .image-cache/ so a
 * failed build's evidence survives into the next run (the same reasoning
 * goldenBuildSerialLogPath documents), while a role writes to its per-run
 * artifacts directory and is discarded with the rest of that run.
 */
export function startScreenshotCapture(
  exec: PowerShellExec,
  vmName: string,
  dir: string,
  opts: { intervalMs?: number; retain?: number } = {},
): ScreenshotHandle {
  const intervalMs = opts.intervalMs ?? CAPTURE_INTERVAL_MS;
  const retain = opts.retain ?? SCREENSHOT_RETAIN;
  mkdirSync(dir, { recursive: true });
  let stopped = false;

  const prune = (): void => {
    const frames = readdirSync(dir)
      .filter((name) => name.endsWith('.bmp'))
      .sort();
    for (const stale of frames.slice(0, Math.max(0, frames.length - retain))) {
      rmSync(join(dir, stale), { force: true });
    }
  };

  const capture = async (): Promise<void> => {
    // Best-effort diagnostics: a failed frame must never fail a build.
    try {
      const { exitCode, stdout } = await exec.run(
        buildThumbnailCommand(vmName, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT),
      );
      if (exitCode !== 0) return;
      const raw = Buffer.from(stdout.trim(), 'base64');
      // GetVirtualSystemThumbnailImage returns 4 bytes more than
      // width*height*2 on every call, regardless of resolution (confirmed on
      // a real host at 80x60, 160x120, and 320x240 alike) — trim to the
      // trailing pixel payload rgb565ToBmp actually expects.
      const pixels = raw.subarray(raw.length - SCREENSHOT_WIDTH * SCREENSHOT_HEIGHT * 2);
      const bmp = rgb565ToBmp(pixels, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(dir, `${stamp}.bmp`), bmp);
      prune();
    } catch {
      // Ignore: the VM may be mid-reboot, off, or not yet rendering.
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await capture();
      for (let waited = 0; waited < intervalMs && !stopped; waited += 500) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const running = loop();

  return {
    stop: async () => {
      stopped = true;
      await running;
    },
  };
}
