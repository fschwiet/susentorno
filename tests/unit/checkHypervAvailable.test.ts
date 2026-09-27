import { describe, expect, it } from 'vitest';
import { describeHypervServiceStatus } from '../checkHypervAvailable';

describe('describeHypervServiceStatus', () => {
  it('returns null when vmms is running', () => {
    expect(describeHypervServiceStatus('Running')).toBeNull();
  });

  it('names the service and how to start it when vmms is stopped', () => {
    const message = describeHypervServiceStatus('Stopped')!;
    expect(message).toContain('vmms');
    expect(message).toContain('Stopped');
    expect(message).toContain('Start-Service vmms');
  });

  it('names enabling the Hyper-V feature when vmms does not exist', () => {
    const message = describeHypervServiceStatus('')!;
    expect(message).toContain('vmms');
    expect(message).toContain('Enable-WindowsOptionalFeature');
  });
});
