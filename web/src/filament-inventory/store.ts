import { useSyncExternalStore } from 'react';
import { projectId } from '../persist/identity';
import { jsonWrite, serviceJson } from '../persist/service';
import { spoolError, type Spool } from './model';

interface Inventory { spools: Spool[] }
interface Snapshot {
  document: Inventory;
  revision: number;
  state: 'loading' | 'ready' | 'saving' | 'failed' | 'conflict';
  error: string | null;
  pending: boolean;
  loaded: boolean;
}
const path = '/api/filament-inventory';
let current: Snapshot = { document: { spools: [] }, revision: 0, state: 'loading', error: null, pending: false, loaded: false };
let operation: { document: Inventory; expectedRevision: number; operationId: string } | null = null;
let running: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
const publish = (patch: Partial<Snapshot>) => { current = { ...current, ...patch }; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useInventory = () => useSyncExternalStore(subscribe, () => current);

function readInventory(value: unknown): { revision: number; document: Inventory } {
  const data = value as { revision?: number; document?: Partial<Inventory> } | null;
  if (!data || !Number.isSafeInteger(data.revision) || data.revision! < 0 || !data.document || typeof data.document !== 'object' || Array.isArray(data.document)) throw new Error('The saved inventory could not be read.');
  const spools = data.document.spools ?? (data.revision === 0 && !Object.keys(data.document).length ? [] : null);
  if (!Array.isArray(spools) || spools.length > 10000 || spools.some((spool) => !spool || spoolError(spool)) || new Set(spools.map((spool) => spool.id)).size !== spools.length) throw new Error('The saved inventory contains invalid spool data.');
  return { revision: data.revision!, document: { spools } };
}

export function loadInventory(): Promise<boolean> {
  if (running) return running;
  publish({ state: 'loading', error: null });
  running = (async () => {
    try {
      const next = readInventory(await serviceJson(path));
      operation = null;
      publish({ ...next, state: 'ready', error: null, loaded: true, pending: false });
      return true;
    } catch (error) {
      publish({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { running = null; }
  })();
  return running;
}

export function saveInventory(spools: Spool[], expectedRevision: number): Promise<boolean> {
  if (running || current.state !== 'ready' || operation) return Promise.resolve(false);
  const invalid = spools.map(spoolError).find(Boolean);
  if (invalid) { publish({ state: 'failed', error: invalid }); return Promise.resolve(false); }
  operation = { document: { spools: structuredClone(spools) }, expectedRevision, operationId: projectId() };
  return retryInventorySave();
}

export function retryInventorySave(): Promise<boolean> {
  if (running) return running;
  if (!operation || current.state === 'conflict') return Promise.resolve(false);
  const captured = operation;
  publish({ state: 'saving', error: null, pending: true });
  running = (async () => {
    try {
      const ack = await serviceJson<{ revision: number; operationId: string }>(path, jsonWrite('PUT', captured));
      if (ack?.operationId !== captured.operationId || ack.revision !== captured.expectedRevision + 1) throw new Error('The server did not confirm the inventory save. Retry to check it.');
      operation = null;
      publish({ document: captured.document, revision: ack.revision, state: 'ready', error: null, pending: false, loaded: true });
      return true;
    } catch (error) {
      const conflict = (error as { code?: string }).code === 'revision_conflict';
      publish({ state: conflict ? 'conflict' : 'failed', error: conflict
        ? 'Inventory changed in another window. Reload the saved inventory and review the latest weights before making this change again.'
        : `${error instanceof Error ? error.message : String(error)} Your change has not been confirmed. Retry the save or reload to check the saved inventory.` });
      return false;
    } finally { running = null; }
  })();
  return running;
}
