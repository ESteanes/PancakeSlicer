import { sessionId } from '../api/session';
import { setState, toast, type State } from '../state/store';
import { snapshot, documentGeneration, historyEditing, receiveHistoryChanges, type Doc } from '../state/history';
import { setEditGuard } from '../state/edit-guard';
import { applyShared, joinShared, sharedChanges, splitShared } from '../persist/shared-document';
import { encode, decode, type StoredDoc } from '../persist/session';
import { readAsset } from '../persist/service';
import { acquireResources, collaborative, editingStatus, forgetResources, heldTokens, joinProject, ownsResource, readShared,
  releaseResources, rememberLocal, rememberShared, renewResources, sharedBase, updateEditingStatus, receiveEditingStatus, type EditingUpdate, type SharedRecord } from '../persist/project-collaboration';
import { adoptShared, flushProject, project } from './project';
import { versionShown, versionView } from './version-view';
import { savedVersionBase } from '../projects/versions';

let started = false, active: string | null = null, activeGeneration = -1;
let controller: AbortController | null = null;
let baseline: { record: SharedRecord; live: Doc } | null = null;
let syncing: Promise<void> | null = null;
let lastNotice = 0;
let targetRevision = 0;

async function initializeBaseline(record: SharedRecord, live?: Doc) {
  const generation = documentGeneration(), id = record.meta.id;
  const fields = live ?? await decode(record.doc as StoredDoc, readAsset);
  if (id !== active || generation !== documentGeneration()) return;
  baseline = { record, live: { ...snapshot(), ...fields } as Doc };
  rememberLocal(id, encode(baseline.live).stored);
}

export async function prepareSharedReplacement() {
  const id = project.get().context.id, generation = documentGeneration();
  const record = await readShared(id);
  const keys = [...new Set([...Object.keys(splitShared(record.doc)), ...Object.keys(splitShared(snapshot()))])];
  const before = heldTokens(id);
  await acquireResources(id, keys);
  try {
    if (id !== active || generation !== documentGeneration() || editingStatus().revision !== record.meta.revision)
      throw new Error('The project changed while acquiring editing locks. Try again.');
    rememberShared(record, true);
    await initializeBaseline(record);
    activeGeneration = generation;
    return record.meta;
  } catch (error) {
    await releaseResources(id, keys.filter(key => !before[key])).catch(() => {});
    throw error;
  }
}

export async function acceptSharedRecord(record: SharedRecord, submitted?: Doc) {
  const id = record.meta.id, generation = documentGeneration(), current = snapshot();
  if (project.get().context.id !== id) return;
  const prior = submitted ?? baseline?.live ?? current;
  const before = splitShared(prior, baseline && splitShared(baseline.record.doc) || undefined);
  const pending = sharedChanges(before, splitShared(current, before));
  const reuse = submitted ? { doc: encode(submitted).stored, state: submitted }
    : baseline ? { doc: baseline.record.doc as StoredDoc, state: baseline.live } : undefined;
  await (await import('../profiles/catalog-startup')).ensureProjectCatalogs(record.doc as StoredDoc,
    () => generation === documentGeneration() && project.get().context.id === id);
  const fields = await decode(record.doc as StoredDoc, readAsset, reuse);
  if (generation !== documentGeneration() || project.get().context.id !== id) return;
  if (!submitted && (project.get().value !== 'saved' || historyEditing() || versionView.get().value !== 'latest')) return;
  const remote = { ...current, ...fields } as Doc;
  const remoteResources = splitShared(remote, splitShared(record.doc));
  const latest = snapshot();
  const additional = sharedChanges(splitShared(current, before), splitShared(latest, before));
  const combined = applyShared(applyShared(remoteResources, pending), additional);
  const next = joinShared(combined, latest) as unknown as Doc;
  if (baseline) receiveHistoryChanges(sharedChanges(splitShared(baseline.live), remoteResources));
  adoptShared(() => setState(next));
  rememberShared(record);
  rememberLocal(id, encode(remote).stored);
  baseline = { record, live: remote };
  savedVersionBase(id, remote);
  if (!submitted) project.send({ type: 'SYNC', meta: record.meta });
}

export function syncSharedProject(): Promise<void> {
  if (syncing) return syncing;
  const id = active;
  if (!id || project.get().value !== 'saved' || historyEditing() || versionView.get().value !== 'latest') return Promise.resolve();
  syncing = (async () => {
    const record = await readShared(id);
    if (id !== active || (record.meta.revision ?? 0) <= project.get().context.revision) return;
    await acceptSharedRecord(record);
  })().finally(() => { syncing = null; });
  return syncing;
}

export async function editResources(keys: string[]) {
  const id = active;
  if (!id) return;
  await flushProject();
  await syncSharedProject();
  if (id !== active) return;
  await acquireResources(id, keys);
  await syncSharedProject();
}
export async function finishEditing(keys?: string[]) {
  const id = active;
  if (!id) return;
  await flushProject();
  await releaseResources(id, keys);
}
export function canManipulateObjects(ids: number[]): boolean {
  const id = project.get().context.id;
  if (!collaborative() || project.get().context.revision === 0) return true;
  return editingStatus().connected && !syncing && editingStatus().revision <= project.get().context.revision && ids.every(object => ownsResource(id, `object:${object}`));
}

function checkEdit(before: State, after: State): boolean {
  const state = project.get();
  if (!collaborative() || state.context.revision === 0 || state.value === 'opening' || state.value === 'missing') return true;
  const a = snapshot(before), b = snapshot(after);
  if (Object.keys(a).every(key => key === 'selected' || a[key as keyof Doc] === b[key as keyof Doc])) return true;
  const base = splitShared(a), changes = sharedChanges(base, splitShared(b, base));
  if (versionShown() && changes.length) return false;
  const protectedChanges = changes.filter(change => change.key === 'settings' || change.before !== null);
  if (!protectedChanges.length) return true;
  const status = editingStatus();
  const missing = protectedChanges.find(change => !ownsResource(state.context.id, change.key));
  if (!missing && status.connected && !syncing && status.revision <= state.context.revision) return true;
  if (Date.now() - lastNotice > 1500) {
    lastNotice = Date.now();
    const lock = missing && status.locks[missing.key];
    const message = !status.connected ? 'Reconnect to the project before editing.' : syncing || status.revision > state.context.revision ? 'Wait for the latest shared changes to finish loading.'
      : lock && lock.session !== sessionId ? `Currently being edited by ${lock.label}.`
      : missing?.key === 'settings' ? 'Click Edit settings to change shared settings.' : 'Click Edit selected objects, or Edit whole project for an operation affecting several objects.';
    queueMicrotask(() => toast(message));
  }
  return false;
}

async function follow(id: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await joinProject(id);
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/collaboration/events`, {
        signal, cache: 'no-store', headers: { 'X-Orca-Session': sessionId, Accept: 'text/event-stream' },
      });
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('Shared updates are unavailable.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Connection to the shared project was interrupted.');
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) throw new Error('Shared update exceeded the size limit.');
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const line = block.split('\n').find(line => line.startsWith('data: '));
            if (!line || id !== active) continue;
            const value = JSON.parse(line.slice(6)) as EditingUpdate & { deleted?: boolean };
            if (value.deleted) {
              updateEditingStatus({ connected: false, error: 'This project was deleted.' });
              project.send({ type: 'ERROR', error: 'This project was deleted elsewhere. Keep your draft as a new project.' });
              return;
            }
            targetRevision = value.revision;
            receiveEditingStatus(id, value);
            if (value.revision > project.get().context.revision) await syncSharedProject();
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (signal.aborted || id !== active) return;
      updateEditingStatus({ connected: false, error: error instanceof Error ? error.message : 'Shared updates disconnected.' });
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000); signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}

export function startCollaboration() {
  if (started || !collaborative()) return;
  started = true;
  setEditGuard(checkEdit);
  const changed = () => {
    const { context, value } = project.get();
    if (versionShown() && context.id === active) return;
    const id = context.revision > 0 && !['blank', 'opening', 'missing', 'deleted'].includes(value) ? context.id : null;
    const generation = documentGeneration();
    if (id === active && generation === activeGeneration) {
      if (value === 'saved' && targetRevision > context.revision) void syncSharedProject().catch(error => updateEditingStatus({ error: String(error) }));
      return;
    }
    const old = active;
    controller?.abort(); controller = null;
    if (old && old !== id) void releaseResources(old).catch(() => {}).finally(() => forgetResources(old));
    active = id; activeGeneration = generation; targetRevision = 0;
    baseline = null;
    updateEditingStatus({ id, revision: context.revision, locks: {}, connected: false, error: null });
    if (!id) return;
    const record = sharedBase(id);
    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      if (record) await initializeBaseline(record, value === 'saved' && !context.dirty ? snapshot() : undefined);
      if (!signal.aborted) await follow(id, signal);
    })().catch(error => { if (!signal.aborted) updateEditingStatus({ error: String(error), connected: false }); });
  };
  project.subscribe(changed);
  changed();
  setInterval(() => {
    const id = active;
    if (!id || !Object.keys(heldTokens(id)).length) return;
    void renewResources(id).catch(error => {
      if (id === active) updateEditingStatus({ connected: false, error: `Editing locks were lost. Reload before continuing. ${String(error)}` });
    });
  }, 10000);
  window.addEventListener('pagehide', () => { if (active) void finishEditing().catch(() => {}); });
}
