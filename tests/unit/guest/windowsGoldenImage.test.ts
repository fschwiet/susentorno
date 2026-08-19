import { describe, expect, it } from 'vitest';
import { computeStampMap, diffStampMaps } from '../../guest/hyperv/stampMap';
import {
  buildWindowsStampInputs,
  describeStaleImage,
  MAX_IMAGE_AGE_DAYS,
} from '../../guest/hyperv/windowsGoldenImage';

const args = {
  answerXml: '<unattend/>',
  provisioningScript: 'Write-Host hi',
  isoSha256: 'a'.repeat(64),
  password: 'secret',
};

describe('buildWindowsStampInputs', () => {
  it('covers every input that changes the built image', () => {
    expect(Object.keys(buildWindowsStampInputs(args)).sort()).toEqual([
      'answerXml',
      'buildAlgorithmVersion',
      'isoSha256',
      'password',
      'provisioningScript',
    ]);
  });

  it('moves the stamp when any single input moves, and names that input', () => {
    const previous = computeStampMap(buildWindowsStampInputs(args));
    for (const [key, value] of [
      ['answerXml', '<other/>'],
      ['provisioningScript', 'Write-Host bye'],
      ['isoSha256', 'b'.repeat(64)],
      ['password', 'other'],
    ] as const) {
      const next = computeStampMap(buildWindowsStampInputs({ ...args, [key]: value }));
      expect(diffStampMaps(previous, next), key).toEqual([key]);
    }
  });
});

describe('describeStaleImage', () => {
  it('names the changed inputs and the rebuild switch', () => {
    const message = describeStaleImage(['answerXml', 'isoSha256'], 3);
    expect(message).toContain('answerXml');
    expect(message).toContain('isoSha256');
    expect(message).toContain('SUSENTORNO_WINDOWS_IMAGE_REBUILD');
  });

  it('reports expiry when the image is older than the evaluation window allows', () => {
    const message = describeStaleImage([], MAX_IMAGE_AGE_DAYS + 1);
    expect(message).toContain('evaluation');
    expect(message).toContain(String(MAX_IMAGE_AGE_DAYS));
  });
});
