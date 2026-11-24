import { useSyncExternalStore } from 'react';
import { sessionId } from '../api/session';
import { deviceLabel } from '../flow/project-lease';
import type { VersionChange } from '../projects/version-change';
import { newKey, type ProjectMeta, type StoredDocBase } from './backend';
import { jsonWrite, serviceJson } from './service';
import { sharedChanges, splitShared, type Resources, type ResourceChange } from './shared-document';

export interface SharedRecord { meta: ProjectMeta; doc: StoredDocBase; jobReferences?: unknown }
export interface EditingLock { session: string; label: string; token?: string; expires: number }
export interface EditingUpdate { revision: number; locks: Record<string, EditingLock>; now: number }
export interface EditingStatus { id: string | null; revision: number; locks: Record<string, EditingLock>; connected: boolean; error: string | null }
export const collaborative = () => import.meta.env.MODE !== 'demo';
const bases = new Map<string, SharedRecord>();
const localBases = new Map<string, Resources>();
const joined = new Map<string, Promise<void>>();
const owned = new Map<string, Record<string, EditingLock>>();
const clocks = new Map<string, number>();
const observedAt = new Map<string, number>();
const lost = new Set<string>();
const listeners = new Set<() => void>();
let status: EditingStatus = { id: null, revision: 0, locks: {}, connected: false, error: null };
const path = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
export const editingStatus = () => status;
export const useEditingStatus = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, editingStatus);
export function updateEditingStatus(patch: Partial<EditingStatus>) {
  status = { ...status, ...patch };
  listeners.forEach(listener => listener());
}
export function receiveEditingStatus(id: string, value: EditingUpdate) {
  if (value.now <= (observedAt.get(id) ?? 0)) return;
  observedAt.set(id, value.now);
  clocks.set(id, value.now - Date.now());
  const locks = owned.get(id);
  for (const [key, lock] of Object.entries(locks ?? {})) {
    if (value.locks[key]?.token === lock.token) continue;
    delete locks![key];
    lost.add(id);
  }
  if (status.id === id) updateEditingStatus({ revision: value.revision, locks: value.locks, connected: true,
    error: lost.has(id) ? 'An editing lock was lost. Reload or keep your recovered edits before continuing.' : null });
}
export const sharedBase = (id: string) => bases.get(id);
export function rememberShared(record: SharedRecord, reset = false) {
  bases.set(record.meta.id, record);
  if (reset) { pending.delete(record.meta.id); localBases.delete(record.meta.id); }
}
export function rememberLocal(id: string, doc: unknown) {
  const base = bases.get(id);
  localBases.set(id, splitShared(doc, base && splitShared(base.doc)));
}
export const localBase = (id: string) => localBases.get(id);
export async function readShared(id: string) {
  const record = await serviceJson<SharedRecord>(path(id));
  if (!record) throw new Error('The shared project could not be loaded.');
  return record;
}
export function joinProject(id: string): Promise<void> {
  let promise = joined.get(id);
  if (!promise) {
    promise = serviceJson<{ revision: number; locks: Record<string, EditingLock> }>(`${path(id)}/collaboration`, jsonWrite('POST', {}))
      .then(result => { if (!result) throw new Error('Shared editing is unavailable.'); })
      .catch(error => { joined.delete(id); throw error; });
    joined.set(id, promise);
  }
  return promise;
}
export function heldTokens(id: string): Record<string, string> {
  return Object.fromEntries(Object.entries(owned.get(id) ?? {}).filter(([, lock]) => lock.expires > Date.now() + (clocks.get(id) ?? 0) + 1000 && lock.token).map(([key, lock]) => [key, lock.token!]));
}
export function ownsResource(id: string, key: string): boolean { return !!heldTokens(id)[key]; }
async function lockRequest(id: string, action: 'acquire' | 'renew' | 'release', keys: string[]) {
  const tokens = Object.fromEntries(Object.entries(owned.get(id) ?? {}).map(([key, lock]) => [key, lock.token]));
  const result = await serviceJson<EditingUpdate>(`${path(id)}/locks`,
    jsonWrite('POST', { action, keys: [...new Set(keys)], tokens, label: `${deviceLabel()} · ${sessionId.slice(0, 4)}` }));
  if (!result) throw new Error('Could not confirm editing locks.');
  clocks.set(id, result.now - Date.now());
  observedAt.set(id, result.now);
  lost.delete(id);
  owned.set(id, Object.fromEntries(Object.entries(result.locks).filter(([, lock]) => lock.session === sessionId)));
  if (status.id === id) updateEditingStatus({ ...result, connected: true, error: null });
  return result;
}
const lockQueues = new Map<string, Promise<unknown>>();
export function acquireResources(id: string, keys: string[]): Promise<void> {
  const next = (lockQueues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await joinProject(id);
    await lockRequest(id, 'acquire', keys);
  });
  lockQueues.set(id, next);
  return next;
}
export async function renewResources(id: string) {
  const next = (lockQueues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const keys = Object.keys(owned.get(id) ?? {});
    if (!keys.length) return;
    try { await lockRequest(id, 'renew', keys); }
    catch (error) { owned.delete(id); lost.add(id); throw error; }
  });
  lockQueues.set(id, next);
  await next;
}
export async function releaseResources(id: string, keys?: string[]) {
  const next = (lockQueues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const release = keys ?? Object.keys(owned.get(id) ?? {});
    if (release.length) await lockRequest(id, 'release', release);
  });
  lockQueues.set(id, next);
  await next;
}
export function forgetResources(id: string) { owned.delete(id); joined.delete(id); }

interface PendingWrite { operationId: string; request: RequestInit; target: Resources }
const pending = new Map<string, PendingWrite>();
export async function saveShared(id: string, doc: StoredDocBase, metadata: { thumbnail?: string | null; change?: VersionChange[] } = {}) {
  await joinProject(id);
  let base = bases.get(id), local = localBases.get(id);
  if (!base || !local) throw new Error('Reload this project before saving shared edits.');
  const target = splitShared(doc, local);
  for (;;) {
    let write = pending.get(id);
    if (!write) {
      const remote = splitShared(base.doc);
      const changes: ResourceChange[] = sharedChanges(local, target).map(change => ({ ...change, before: remote[change.key] ?? null }));
      if (!changes.length) return { revision: base.meta.revision!, savedAt: base.meta.savedAt, record: base };
      const additions = changes.filter(change => change.key !== 'settings' && change.before === null).map(change => change.key);
      if (additions.length) await acquireResources(id, additions);
      const tokens = heldTokens(id);
      for (const change of changes) {
        if (!tokens[change.key]) throw Object.assign(new Error('An editing lock was lost. Reload the latest project before continuing; your draft has been kept.'), { name: 'ProjectConflictError', code: 'edit_lock_required', status: 409 });
        change.token = tokens[change.key];
      }
      const stored = doc as StoredDocBase & { recoveryCheckpoint?: unknown };
      const operationId = newKey();
      write = { operationId, target, request: jsonWrite('POST', { operationId, changes, files: doc.files ?? {}, checkpoint: stored.recoveryCheckpoint, ...metadata }) };
      pending.set(id, write);
    }
    const ack = await serviceJson<{ revision: number; operationId: string }>(`${path(id)}/changes`, write.request).catch((error: unknown) => {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500) pending.delete(id);
      throw error;
    });
    if (!ack || ack.operationId !== write.operationId || !Number.isSafeInteger(ack.revision) || ack.revision < 1)
      throw new Error('Could not verify the shared project save.');
    const record = await readShared(id);
    if (record.meta.id !== id || !Number.isSafeInteger(record.meta.revision) || record.meta.revision! < ack.revision)
      throw new Error('Could not verify the shared project save.');
    pending.delete(id);
    base = record;
    rememberShared(base);
    localBases.set(id, write.target);
    if (write.target === target) return { revision: base.meta.revision!, savedAt: base.meta.savedAt, record: base };
    local = write.target;
  }
}
