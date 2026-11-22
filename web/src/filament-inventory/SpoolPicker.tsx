import { useEffect } from 'react';
import { Dropdown } from '../components/Dropdown';
import { effectiveConfig, getState, markStale, setState, toast, useStore } from '../state/store';
import { undoable } from '../state/history';
import { setSlotColour, slotColour } from '../profiles/filament-colour';
import { slotFilaments, slotMixes } from '../profiles/slots';
import { grams, materialKey } from './model';
import { inventorySnapshot, loadInventory, useInventory } from './store';
import './inventory.css';

export function SpoolPicker({ slot }: { slot: number }) {
  const inventory = useInventory();
  const id = useStore((s) => s.slotSpools[slot] ?? '');
  const mixed = useStore((s) => !!slotMixes(s)[slot]);
  const material = useStore((s) => materialKey(String([effectiveConfig(s, 'filament', slot).filament_type].flat()[0] ?? '')));
  const colour = useStore((s) => slotColour(s, slot));
  useEffect(() => { const current = inventorySnapshot(); if (!current.loaded && current.state === 'loading') void loadInventory(); }, []);
  if (mixed) return null;
  const selected = inventory.document.spools.find((spool) => spool.id === id);
  const missing = inventory.loaded && id && !selected;
  const mismatch = selected && materialKey(selected.material) !== material;
  const pick = async (spoolId: string) => {
    const spool = inventorySnapshot().document.spools.find((item) => item.id === spoolId);
    if (spoolId && (!spool || spool.remainingGrams <= 0 || materialKey(spool.material) !== material)) return;
    const recolour = !!spool && slotColour(getState(), slot).toUpperCase() !== spool.colour.toUpperCase();
    if (spool && recolour) {
      try { await setSlotColour(slot, spool.colour); }
      catch (error) { toast('inventory_spool_failed', { detail: error instanceof Error ? error.message : String(error) }); return; }
    }
    undoable('Select inventory spool', () => setState((s) => ({
      slotSpools: slotFilaments(s).map((_, i) => i === slot ? spoolId || null : s.slotSpools[i] ?? null),
      job: recolour ? markStale(s.job) : s.job,
    })));
    if ((getState().slotSpools[slot] ?? '') === spoolId && spool) toast('inventory_spool_selected', { slot: slot + 1, name: spool.name, remaining: grams(spool.remainingGrams) });
  };
  const options = inventory.document.spools.filter((spool) => spool.id === id || materialKey(spool.material) === material && spool.remainingGrams > 0)
    .sort((a, b) => a.colourName.localeCompare(b.colourName) || a.name.localeCompare(b.name))
    .map((spool) => ({ value: spool.id, label: `${spool.colourName} · ${spool.name} · ${grams(spool.remainingGrams)}`,
      disabled: spool.remainingGrams <= 0 || materialKey(spool.material) !== material }));
  return <div className="inventory-slot">
    <Dropdown className="combo" aria-label={`Inventory spool for filament ${slot + 1}`} value={id} disabled={inventory.state !== 'ready'}
      onValueChange={(value) => void pick(value)} options={[{ value: '', label: inventory.loaded ? 'Inventory spool: untracked' : 'Loading inventory…' }, ...options,
        ...(missing ? [{ value: id, label: 'Selected spool was deleted', disabled: true }] : [])]} />
    {mismatch && <span className="modal-error">Choose a {material} spool or change the filament profile.</span>}
    {selected && !mismatch && selected.colour.toUpperCase() !== colour.toUpperCase() && <button type="button" className="btn-ghost" disabled={inventory.state !== 'ready' || selected.remainingGrams <= 0} onClick={() => void pick(id)}>Apply updated spool colour</button>}
    {inventory.error && <button type="button" className="btn-ghost" onClick={() => setState({ appDialog: 'inventory' })}>Resolve inventory save issue</button>}
    {inventory.loaded && !options.length && <span className="inventory-hint">Add a {material || 'matching material'} spool in Filament inventory.</span>}
  </div>;
}
