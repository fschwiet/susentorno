export interface Closable { close(): Promise<void>; }
export interface ServiceStack { add<T extends Closable>(start: () => Promise<T>): Promise<T>; closeAll(): Promise<void>; }
export function createServiceStack(): ServiceStack {
  const started: Closable[] = [];
  const closeAll = async (): Promise<void> => { while (started.length > 0) { const service = started.pop(); try { await service?.close(); } catch { /* ignore */ } } };
  return { add: async <T extends Closable>(start: () => Promise<T>): Promise<T> => { let service: T; try { service = await start(); } catch (err) { await closeAll(); throw err; } started.push(service); return service; }, closeAll };
}
