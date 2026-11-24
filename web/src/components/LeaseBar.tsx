import { useEffect, useState } from 'react';
import { takeControl, useProjectLease } from '../flow/project-lease';
import { Sep } from '../separator';
import { collaborative, heldTokens, useEditingStatus } from '../persist/project-collaboration';
import { selectedObjectIds, toast, useStore } from '../state/store';
import { editResources, finishEditing } from '../flow/collaboration';
import { sessionId } from '../api/session';
const EDIT_KEYS = /^(Delete|Backspace)$/;
const EDIT_CHORDS = /^[xvzydai]$/i;

export default function LeaseBar() {
  return collaborative() ? <SharedEditingBar /> : <LegacyLeaseBar />;
}

function SharedEditingBar() {
  const status = useEditingStatus();
  const s = useStore(s => s);
  const [busy, setBusy] = useState(false);
  if (!status.id || s.tab === 'projects') return null;
  const tokens = heldTokens(status.id);
  const selected = selectedObjectIds(s).map(id => `object:${id}`);
  const all = [...new Set([...s.objects, ...s.projectPlates.flatMap(p => p.objects)].map(o => `object:${o.id}`))];
  const held = (keys: string[]) => keys.length > 0 && keys.every(key => !!tokens[key]);
  const foreign = (keys: string[]) => keys.map(key => status.locks[key]).find(lock => lock && lock.session !== sessionId);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().catch(error => toast('shared_editing_failed', { detail: error instanceof Error ? error.message : String(error) })).finally(() => setBusy(false));
  };
  const settingsHolder = foreign(['settings']), objectHolder = foreign(selected);
  return <div className="lease-bar" role="region" aria-label="Shared editing">
    <span role="status">{status.error ?? (status.connected ? 'Shared project' : 'Connecting to shared project…')}</span>
    <button type="button" className="btn-secondary" disabled={busy || !status.connected || !!settingsHolder}
      title={settingsHolder ? `Settings are being edited by ${settingsHolder.label}` : 'Printer, material, slicing and plate settings'}
      onClick={() => run(() => held(['settings']) ? finishEditing(['settings']) : editResources(['settings']))}>
      {settingsHolder ? `Settings: ${settingsHolder.label}` : held(['settings']) ? 'Finish editing settings' : 'Edit settings'}
    </button>
    {!!selected.length && <button type="button" className="btn-secondary" disabled={busy || !status.connected || !!objectHolder}
      title={objectHolder ? `Selected object is being edited by ${objectHolder.label}` : 'Lock selected objects, including their parts and instances'}
      onClick={() => run(() => held(selected) ? finishEditing(selected) : editResources(selected))}>
      {objectHolder ? `Object: ${objectHolder.label}` : held(selected) ? 'Finish editing objects' : 'Edit selected objects'}
    </button>}
    <button type="button" className="btn-secondary" disabled={busy || !status.connected || !!foreign(['settings', ...all])}
      onClick={() => run(() => editResources(['settings', ...all]))}>Edit whole project</button>
    {!!Object.keys(tokens).length && <button type="button" className="btn-secondary" disabled={busy}
      onClick={() => run(() => finishEditing())}>Save and release all</button>}
  </div>;
}

function LegacyLeaseBar() {
  const { value, context } = useProjectLease();
  const readOnly = value === 'viewing' || value === 'lost';
  const busy = value === 'requesting' && context.take;
  const show = readOnly || busy;
  useEffect(() => {
    const root = document.documentElement;
    if (!show) { delete root.dataset.readonly; return; }
    root.dataset.readonly = 'true';
    const hold = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable="true"],dialog')) return;
      if (EDIT_KEYS.test(e.key) || ((e.ctrlKey || e.metaKey) && EDIT_CHORDS.test(e.key))) { e.preventDefault(); e.stopPropagation(); }
    };
    const block = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('dialog'))) { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener('keydown', hold, true);
    window.addEventListener('paste', block, true);
    window.addEventListener('drop', block, true);
    return () => { delete root.dataset.readonly; window.removeEventListener('keydown', hold, true); window.removeEventListener('paste', block, true); window.removeEventListener('drop', block, true); };
  }, [show]);
  if (!show) return null;
  return (
    <div className="app-notices"><div className="lease-bar" role="status">
      <span>Currently open in another tab or device{context.holder && <><Sep/>{context.holder.label}</>}</span>
      <button type="button" className="btn-primary" disabled={busy} aria-busy={busy} onClick={takeControl}>{busy ? 'Taking control…' : 'Take control'}</button>
    </div></div>
  );
}
