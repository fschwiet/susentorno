import { describe, expect, it } from 'vitest';
import { describeWindowsIsoImages } from '../checkWindowsIso';

const iso = 'C:\\images\\win.iso';

describe('describeWindowsIsoImages', () => {
  it('returns null when install.wim holds an x64 en-us image', () => {
    expect(
      describeWindowsIsoImages(iso, 'IMAGE|9|en-US|Windows 11 Enterprise Evaluation\n'),
    ).toBeNull();
  });

  it('ignores noise around the image lines', () => {
    expect(
      describeWindowsIsoImages(
        iso,
        'WARNING: something\r\nIMAGE|12|en-US|Windows 11 Pro\r\nIMAGE|9|fr-FR,en-US|Windows 11 Enterprise\r\n',
      ),
    ).toBeNull();
  });

  it('names the actual architecture when the image is arm64', () => {
    const message = describeWindowsIsoImages(iso, 'IMAGE|12|en-US|Windows 11 Enterprise')!;
    expect(message).toContain(iso);
    expect(message).toContain('arm64');
    expect(message).toContain('en-US');
    expect(message).toContain('x64');
  });

  it('names the actual language when the image is en-gb', () => {
    const message = describeWindowsIsoImages(iso, 'IMAGE|9|en-GB|Windows 11 Enterprise')!;
    expect(message).toContain('x64');
    expect(message).toContain('en-GB');
    expect(message).toContain('en-us');
  });

  it('says install.wim is missing when the ISO has none', () => {
    const message = describeWindowsIsoImages(iso, 'NO-INSTALL-WIM\n')!;
    expect(message).toContain(iso);
    expect(message).toContain('install.wim');
  });
});
