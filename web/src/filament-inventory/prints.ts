import { jsonWrite, serviceJson } from '../persist/service';
import { acceptInventory } from './store';
import type { PrintRecord, PrintRequest } from './model';

const path = '/api/filament-inventory/prints', key = 'orca.inventory.pending-prints';
const pending = new Map<string, PrintRequest>();
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
  if (Array.isArray(saved)) for (const request of saved) {
    if (request && typeof request.jobId === 'string' && typeof request.printId === 'string' && typeof request.name === 'string'
      && Number.isSafeInteger(request.expectedRevision) && Array.isArray(request.assignments)
      && request.assignments.every((row: { slot?: number; spoolId?: string }) => row && Number.isInteger(row.slot) && typeof row.spoolId === 'string')) pending.set(request.jobId, request);
  }
} catch { }
const persist = () => sessionStorage.setItem(key, JSON.stringify([...pending.values()]));
export const pendingPrint = (jobId: string) => pending.get(jobId) ?? null;
export function forgetPrint(jobId: string) {
  pending.delete(jobId);
  try { persist(); } catch { }
}
export async function printHistory(jobId: string): Promise<PrintRecord[]> {
  const records = await serviceJson<PrintRecord[]>(`${path}?jobId=${encodeURIComponent(jobId)}`);
  if (!Array.isArray(records)) throw new Error('Print history could not be read.');
  return records;
}
export async function recordPrint(request: PrintRequest): Promise<PrintRecord> {
  pending.set(request.jobId, structuredClone(request));
  try { persist(); } catch { throw new Error('The pending print could not be kept for retry. Free browser storage and try again.'); }
  const result = await serviceJson<{ print: PrintRecord; revision: number; document: unknown }>(path, jsonWrite('POST', request));
  if (!result || result.print?.id !== request.printId || result.print.jobId !== request.jobId) throw new Error('The server did not confirm this print. Retry the same recording.');
  acceptInventory(result);
  forgetPrint(request.jobId);
  return result.print;
}

export const rejectedPrint = (code: string | undefined) => !!code && ['revision_conflict', 'insufficient_filament', 'inventory_spool_missing', 'invalid_inventory_print', 'inventory_slice_unavailable', 'inventory_print_conflict'].includes(code);
