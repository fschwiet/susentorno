import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptSubnetForCreateHostNetwork } from '../../../src/commands/createHostNetwork';

vi.mock('../../../src/cliPrompt', () => ({
  promptText: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('promptSubnetForCreateHostNetwork', () => {
  it('returns the first valid answer', async () => {
    const { promptText } = await import('../../../src/cliPrompt');
    vi.mocked(promptText).mockResolvedValueOnce('67');

    const n = await promptSubnetForCreateHostNetwork([], 0);

    expect(n).toBe(67);
    expect(promptText).toHaveBeenCalledWith('Subnet (192.168.<n>.x)', '0');
  });

  it('re-prompts after an invalid answer, printing why', async () => {
    const { promptText } = await import('../../../src/cliPrompt');
    vi.mocked(promptText).mockResolvedValueOnce('300').mockResolvedValueOnce('67');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const n = await promptSubnetForCreateHostNetwork([], 0);

    expect(n).toBe(67);
    expect(promptText).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('create-host-network:'));
  });
});
