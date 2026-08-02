import { describe, it, expect } from 'vitest';
import { allocateMcpPorts } from '../../src/runHosting/allocateMcpPorts';

describe('allocateMcpPorts', () => {
  it('returns the requested number of distinct ports', async () => {
    const ports = await allocateMcpPorts(3);
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(port).toBeGreaterThan(0);
  });

  it('returns an empty array for zero servers', async () => {
    expect(await allocateMcpPorts(0)).toEqual([]);
  });
});
