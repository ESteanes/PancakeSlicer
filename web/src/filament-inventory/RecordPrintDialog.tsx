import { useEffect, useState } from 'react';
import { canExport } from '../actions';
import { Modal, ModalBody, ModalFooter, ModalTitle } from '../components/Modal';
import { projectId } from '../persist/identity';
import { slotColour } from '../profiles/filament-colour';
import { slotFilaments, slotMixes } from '../profiles/slots';
import { effectiveConfig, getState, useStore } from '../state/store';
import { grams, materialKey, sliceFilamentUsage, spoolUsage, type PrintRecord, type PrintRequest } from './model';
import { forgetPrint, pendingPrint, printHistory, recordPrint, rejectedPrint } from './prints';
import { inventorySnapshot, loadInventory, useInventory } from './store';
import './inventory.css';

export default function RecordPrintDialog({ close }: { close(): void }) {
  const [source] = useState(getState), inventory = useInventory();
  const jobId = source.job.id ?? '';
  const [command, setCommand] = useState<PrintRequest | null>(() => pendingPrint(jobId));
  const [records, setRecords] = useState<PrintRecord[]>([]), [recorded, setRecorded] = useState<PrintRecord | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [repeat, setRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null), [code, setCode] = useState<string>();
  const fresh = useStore((s) => canExport(s) && !s.job.calib && s.job.id === jobId && s.job.plateSignature === source.job.plateSignature && JSON.stringify(s.slotSpools) === JSON.stringify(source.slotSpools));
  const usage = sliceFilamentUsage(source.job.status?.record);
  const assignments = command?.assignments ?? (usage ?? []).map((row) => ({ slot: row.slot, spoolId: source.slotSpools[row.slot] ?? '' }));
  const totals = spoolUsage(usage ?? [], assignments);
  const issues: string[] = [];
  if (!usage) issues.push('This slice has no usable filament weight estimates. Slice the plate again.');
  if (!fresh) issues.push('The plate or its spool selections changed. Close this window and review a fresh slice before recording a print.');
  for (const row of usage ?? []) {
    const id = assignments.find((assignment) => assignment.slot === row.slot)?.spoolId;
    const spool = inventory.document.spools.find((item) => item.id === id);
    if (!spool) { issues.push(`Choose an inventory spool for filament ${row.slot + 1} in the Filament panel.`); continue; }
    if (slotMixes(source)[row.slot] || row.slot >= slotFilaments(source).length) { issues.push(`Filament ${row.slot + 1} cannot be attributed to a single physical spool. Record its actual usage in inventory.`); continue; }
    const material = materialKey(String([effectiveConfig(source, 'filament', row.slot).filament_type].flat()[0] ?? ''));
    if (materialKey(spool.material) !== material) issues.push(`${spool.name} is ${spool.material}, but filament ${row.slot + 1} is ${material}. Choose a matching spool.`);
    if (spool.colour.toUpperCase() !== slotColour(source, row.slot).toUpperCase()) issues.push(`The colour of ${spool.name} changed. Apply its updated colour in the Filament panel and slice the plate again.`);
  }
  for (const [id, weight] of totals) {
    const spool = inventory.document.spools.find((item) => item.id === id);
    if (spool && weight > spool.remainingGrams) issues.push(`${spool.name} is short by ${grams(weight - spool.remainingGrams)}. Correct its measured weight or choose another spool.`);
  }
  const reload = async () => {
    setLoading(true); setError(null);
    try {
      if (inventorySnapshot().pending) throw new Error('Finish the pending inventory save in Filament inventory before recording a print.');
      const [loaded, history] = await Promise.all([loadInventory(), printHistory(jobId)]);
      if (!loaded) throw new Error(inventorySnapshot().error ?? 'Inventory could not be loaded.');
      setRecords(history);
      const waiting = pendingPrint(jobId), receipt = waiting && history.find((row) => row.id === waiting.printId);
      if (receipt) { forgetPrint(jobId); setCommand(null); setRecorded(receipt); }
      else if (waiting && rejectedPrint(code)) setCommand({ ...waiting, expectedRevision: inventorySnapshot().revision });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  const submit = async () => {
    if (saving || loading || inventory.pending) return;
    const request = command ?? pendingPrint(jobId) ?? {
      printId: repeat ? projectId() : `print-${jobId}`, jobId,
      name: `${source.projectName ?? source.project?.name ?? source.objects[0]?.name ?? 'Untitled'} · Plate ${source.plateIndex}`.slice(0, 200),
      expectedRevision: inventory.revision, assignments,
    };
    setCommand(request); setSaving(true); setError(null); setCode(undefined);
    try {
      const receipt = await recordPrint(request);
      setRecorded(receipt); setRecords((prior) => [receipt, ...prior.filter((row) => row.id !== receipt.id)]); setCommand(null); setRepeat(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCode((reason as { code?: string }).code); }
    finally { setSaving(false); }
  };
  const alreadyRecorded = !repeat && !command && records.length > 0;
  const busy = saving || loading;
  const canRetry = !!command && !rejectedPrint(code);
  const disabled = busy || !!error && !command || inventory.pending || (!canRetry && (inventory.state !== 'ready' || issues.length > 0));
  const dismiss = () => { if (!busy) close(); };
  return <Modal size="l" label="Record print" onClose={dismiss}>
    <ModalTitle title="Record print" onClose={dismiss} />
    <ModalBody>
      <p>Review the filament used by this plate. Confirm after printing to deduct the slice estimates from the selected spools.</p>
      {loading && <p role="status">Loading inventory and print history…</p>}
      {recorded && <p className="inventory-print-success" role="status">Print recorded. Deducted {grams(recorded.usage.reduce((total, row) => total + row.grams, 0))} from inventory.</p>}
      {alreadyRecorded && !recorded && <p role="status">This slice already has {records.length} recorded print{records.length === 1 ? '' : 's'}. Record another only if you printed the plate again.</p>}
      {!alreadyRecorded && <div className="inventory-print-table-wrap"><table className="inventory-print-table"><thead><tr><th>Inventory spool</th><th>Estimated use</th><th>Available</th><th>After print</th></tr></thead>
        <tbody>{[...totals].map(([id, weight]) => {
          const spool = inventory.document.spools.find((item) => item.id === id);
          return <tr key={id}><th scope="row">{spool ? <><span className="inventory-dot" style={{ backgroundColor: spool.colour }} />{spool.name}<small>{spool.material} · {spool.colourName}</small></> : 'Deleted spool'}</th>
            <td>{grams(weight)}</td><td>{spool ? grams(spool.remainingGrams) : '—'}</td><td className={spool && spool.remainingGrams < weight ? 'modal-error' : ''}>{spool ? grams(spool.remainingGrams - weight) : '—'}</td></tr>;
        })}</tbody></table></div>}
      {!loading && !alreadyRecorded && issues.length > 0 && <ul className="inventory-print-issues">{[...new Set(issues)].map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      {error && <div className="inventory-error" role="alert"><p>{error}</p><div className="inventory-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>Reload inventory and history</button>
        {command && rejectedPrint(code) && <button type="button" className="btn" onClick={() => { forgetPrint(jobId); close(); }}>Discard this recording</button>}
      </div></div>}
      <p className="inventory-hint">Estimates include the filament reported by the slicer. Record any additional purging or failed-print waste separately in inventory.</p>
      {records.length > 0 && <details className="inventory-print-history"><summary>Recorded prints ({records.length})</summary><ul>{records.map((row) => <li key={row.id}><time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleString()}</time><span>{row.usage.map((item) => `${item.name}: ${grams(item.grams)}`).join(' · ')}</span></li>)}</ul></details>}
    </ModalBody>
    <ModalFooter><button type="button" className="btn" disabled={busy} onClick={close}>Close</button>
      {alreadyRecorded ? <button type="button" className="btn" disabled={busy || inventory.pending} onClick={() => { setRepeat(true); setRecorded(null); }}>Record another print</button>
        : <button type="button" className="btn-primary" disabled={disabled} onClick={() => void submit()}>{saving ? 'Recording…' : command ? 'Retry recording' : repeat ? 'Confirm another print' : 'Record print'}</button>}
    </ModalFooter>
  </Modal>;
}
