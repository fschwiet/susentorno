import { describe, it, expect } from 'vitest';
import { createServiceStack, type Closable } from '../../src/runProxy/serviceStack';
function fake(name: string, log: string[]): Closable {
  return {
    close: async () => {
      log.push(name);
    },
  };
}
describe('service-stack start/rollback/close lifecycle', () => {
  it('returns each started service', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    const a = await stack.add(async () => fake('a', log));
    expect(a).toBeDefined();
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });
  it('closes in reverse order on closeAll', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => fake('b', log));
    await stack.add(async () => fake('c', log));
    await stack.closeAll();
    expect(log).toEqual(['c', 'b', 'a']);
  });
  it('rolls back already-started services when one fails to start', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => fake('b', log));
    await expect(
      stack.add(async () => {
        throw new Error('bind EADDRINUSE');
      }),
    ).rejects.toThrow('bind EADDRINUSE');
    expect(log).toEqual(['b', 'a']);
  });
  it('closeAll is idempotent', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.closeAll();
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });
  it('keeps closing the rest when one close throws', async () => {
    const log: string[] = [];
    const stack = createServiceStack();
    await stack.add(async () => fake('a', log));
    await stack.add(async () => ({
      close: async () => {
        throw new Error('close failed');
      },
    }));
    await stack.closeAll();
    expect(log).toEqual(['a']);
  });
});
