import { useEffect, useId, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalTitle } from '../components/Modal';
import { Dropdown } from '../components/Dropdown';
import { FILAMENT_PALETTE } from '../components/filament-palette';
import { projectId } from '../persist/identity';
import { loadInventory, retryInventorySave, saveInventory, useInventory } from './store';
import { grams, spoolError, stockStatus, type Spool } from './model';
import './inventory.css';

const MATERIALS = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS'];
const STATUS = { available: 'In stock', low: 'Low stock', empty: 'Empty' };
type Selection = { kind: 'edit' | 'usage' | 'delete'; spool: Spool; revision: number } | { kind: 'add'; revision: number };

function Recovery({ recovered }: { recovered?(): void }) {
  const inventory = useInventory();
  if (!inventory.error) return null;
  return <div className="inventory-error" role="alert">
    <p>{inventory.error}</p>
    <div className="inventory-actions">
      {inventory.pending && inventory.state === 'failed' && <button type="button" className="btn" onClick={() => void retryInventorySave().then((saved) => { if (saved) recovered?.(); })}>Retry save</button>}
      <button type="button" className="btn" onClick={() => void loadInventory().then((loaded) => { if (loaded) recovered?.(); })}>Reload saved inventory</button>
    </div>
  </div>;
}

function SpoolEditor({ spool, revision, close }: { spool?: Spool; revision: number; close(): void }) {
  const inventory = useInventory(), listId = useId(), errorId = useId();
  const [draft, setDraft] = useState<Spool>(() => spool ?? {
    id: projectId(), name: '', brand: '', material: 'PLA', colour: '#FFFFFF', colourName: 'White', capacityGrams: 1000, remainingGrams: 1000, location: '',
  });
  const [capacity, setCapacity] = useState(String(draft.capacityGrams)), [remaining, setRemaining] = useState(String(draft.remainingGrams));
  const [error, setError] = useState<string | null>(null);
  const busy = inventory.state === 'saving' || inventory.state === 'loading', locked = inventory.state !== 'ready';
  const dismiss = () => { if (!busy) close(); };
  const field = (key: 'name' | 'brand' | 'material' | 'colourName' | 'location', label: string, required = false) => <label className="inventory-field">
    <span>{label}</span><input className="text" value={draft[key]} required={required} maxLength={key === 'location' ? 200 : 100}
      list={key === 'material' ? listId : undefined} data-autofocus={key === 'name' ? '' : undefined}
      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
  </label>;
  const submit = async () => {
    const next = { ...draft, name: draft.name.trim(), brand: draft.brand.trim(), material: draft.material.trim().toUpperCase(), colour: draft.colour.toUpperCase(),
      colourName: draft.colourName.trim(), location: draft.location.trim(), capacityGrams: Number(capacity), remainingGrams: Number(remaining) };
    const invalid = !capacity.trim() || !remaining.trim() ? 'Enter capacity and remaining weight in grams.' : spoolError(next);
    if (invalid) { setError(invalid); return; }
    setError(null);
    const spools = spool ? inventory.document.spools.map((item) => item.id === spool.id ? next : item) : [...inventory.document.spools, next];
    if (await saveInventory(spools, revision)) close();
  };
  const title = spool ? 'Edit spool' : 'Add spool';
  return <Modal size="m" label={title} onClose={dismiss}>
    <ModalTitle title={title} onClose={dismiss} />
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-describedby={error ? errorId : undefined}>
      <ModalBody>
        <fieldset className="inventory-fields" disabled={locked}>
          {field('name', 'Spool name', true)}
          <div className="inventory-form-pair">{field('brand', 'Brand (optional)')}{field('material', 'Material', true)}</div>
          <datalist id={listId}>{MATERIALS.map((material) => <option key={material} value={material} />)}</datalist>
          <div className="inventory-form-pair">
            {field('colourName', 'Colour name', true)}
            <label className="inventory-field"><span>Colour</span><span className="inventory-colour-input">
              <input type="color" aria-label="Pick filament colour" value={/^#[\da-f]{6}$/i.test(draft.colour) ? draft.colour : '#FFFFFF'} onChange={(event) => setDraft({ ...draft, colour: event.target.value })} />
              <input className="text" aria-label="HEX colour" value={draft.colour} maxLength={7} required pattern="#[0-9a-fA-F]{6}" spellCheck={false} onChange={(event) => setDraft({ ...draft, colour: event.target.value })} />
            </span></label>
          </div>
          <div className="inventory-palette" role="group" aria-label="Common filament colours">{FILAMENT_PALETTE.map((colour) => <button key={colour.hex} type="button" className="inventory-swatch" style={{ backgroundColor: colour.hex }} aria-label={colour.name} aria-pressed={draft.colour.toUpperCase() === colour.hex.toUpperCase()}
            onClick={() => setDraft({ ...draft, colour: colour.hex, colourName: colour.name })} />)}</div>
          <div className="inventory-form-pair">
            <label className="inventory-field"><span>Full spool weight (g)</span><input className="text" type="number" required min="0.1" max="1000000" step="0.1" value={capacity} onChange={(event) => {
              const next = event.target.value;
              if (!spool && remaining === capacity) setRemaining(next);
              setCapacity(next);
            }} /></label>
            <label className="inventory-field"><span>Remaining filament (g)</span><input className="text" type="number" required min="0" max={Number(capacity) || 1000000} step="0.1" value={remaining} onChange={(event) => setRemaining(event.target.value)} /></label>
          </div>
          <p className="inventory-hint">Enter filament weight only, excluding the empty spool. You can correct the remaining weight here after weighing it.</p>
          {field('location', 'Storage location (optional)')}
        </fieldset>
        {error && <p className="modal-error" id={errorId} role="alert">{error}</p>}
        <Recovery recovered={close} />
      </ModalBody>
      <ModalFooter><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn-primary" disabled={locked}>{inventory.state === 'saving' ? 'Saving…' : spool ? 'Save changes' : 'Add spool'}</button></ModalFooter>
    </form>
  </Modal>;
}

function UsageDialog({ spool, revision, close }: { spool: Spool; revision: number; close(): void }) {
  const inventory = useInventory(), errorId = useId();
  const [amount, setAmount] = useState(''), [error, setError] = useState<string | null>(null);
  const used = Number(amount), valid = amount.trim() !== '' && Number.isFinite(used) && used > 0 && used <= spool.remainingGrams;
  const after = Math.round((spool.remainingGrams - used) * 10) / 10;
  const busy = inventory.state === 'saving' || inventory.state === 'loading', locked = inventory.state !== 'ready';
  const dismiss = () => { if (!busy) close(); };
  const submit = async () => {
    if (!valid) { setError(`Enter a weight greater than zero and no more than ${grams(spool.remainingGrams)}.`); return; }
    setError(null);
    if (await saveInventory(inventory.document.spools.map((item) => item.id === spool.id ? { ...item, remainingGrams: after } : item), revision)) close();
  };
  return <Modal size="s" label="Record filament usage" onClose={dismiss}>
    <ModalTitle title="Record usage" onClose={dismiss} />
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <ModalBody>
        <p><strong>{spool.name}</strong> · {spool.material} · {spool.colourName}</p>
        <p>{grams(spool.remainingGrams)} remaining</p>
        <label className="inventory-field"><span>Filament used (g)</span><input className="text" type="number" data-autofocus required min="0.1" max={spool.remainingGrams} step="0.1" value={amount} disabled={locked} aria-describedby={error ? errorId : undefined} onChange={(event) => setAmount(event.target.value)} /></label>
        <p className="inventory-hint">Record the amount used by a completed print, including supports and waste. You can also record purging or failed prints here.</p>
        {valid && <p role="status">Remaining after use: <strong>{grams(after)}</strong></p>}
        {error && <p className="modal-error" id={errorId} role="alert">{error}</p>}
        <Recovery recovered={close} />
      </ModalBody>
      <ModalFooter><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn-primary" disabled={locked}>{inventory.state === 'saving' ? 'Saving…' : 'Record usage'}</button></ModalFooter>
    </form>
  </Modal>;
}

function DeleteDialog({ spool, revision, close }: { spool: Spool; revision: number; close(): void }) {
  const inventory = useInventory(), busy = inventory.state === 'saving' || inventory.state === 'loading';
  const dismiss = () => { if (!busy) close(); };
  return <Modal size="s" label="Delete spool" onClose={dismiss} alert>
    <ModalTitle title="Delete spool?" onClose={dismiss} />
    <ModalBody><p>Remove <strong>{spool.name}</strong> ({spool.colourName}, {grams(spool.remainingGrams)} remaining) from your inventory?</p><Recovery recovered={close} /></ModalBody>
    <ModalFooter><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="button" className="btn-danger" disabled={inventory.state !== 'ready'} onClick={() => void saveInventory(inventory.document.spools.filter((item) => item.id !== spool.id), revision).then((saved) => { if (saved) close(); })}>{inventory.state === 'saving' ? 'Deleting…' : 'Delete spool'}</button></ModalFooter>
  </Modal>;
}

export default function InventoryDialog({ close }: { close(): void }) {
  const inventory = useInventory();
  const [query, setQuery] = useState(''), [material, setMaterial] = useState(''), [stock, setStock] = useState('all'), [colour, setColour] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => { if (!inventory.pending) void loadInventory(); }, []);
  const { spools } = inventory.document, ready = inventory.state === 'ready', busy = inventory.state === 'saving' || inventory.state === 'loading';
  const available = spools.filter((spool) => spool.remainingGrams > 0), low = available.filter((spool) => stockStatus(spool) === 'low');
  const materials = [...new Set(spools.map((spool) => spool.material))].sort();
  const colours = [...new Map(available.map((spool) => [spool.colour.toUpperCase(), spool])).values()].sort((a, b) => a.colourName.localeCompare(b.colourName));
  const search = query.trim().toLowerCase();
  const shown = spools.filter((spool) => (!search || [spool.name, spool.brand, spool.material, spool.colourName, spool.colour, spool.location].some((value) => value.toLowerCase().includes(search)))
    && (!material || spool.material === material) && (!colour || spool.colour.toUpperCase() === colour)
    && (stock === 'all' || stock === 'available' && spool.remainingGrams > 0 || stock === stockStatus(spool)))
    .sort((a, b) => Number(a.remainingGrams === 0) - Number(b.remainingGrams === 0) || a.name.localeCompare(b.name));
  const choose = (kind: 'edit' | 'usage' | 'delete', spool: Spool) => setSelection({ kind, spool, revision: inventory.revision });
  const dismiss = () => { if (!busy) close(); };
  return <>
    <Modal size="xl" className="inventory-dialog" label="Filament inventory" onClose={dismiss}>
      <ModalTitle title="Filament inventory" onClose={dismiss} />
      <ModalBody>
        <p>Track your spools, available colours and remaining filament. Record usage after printing to keep quantities up to date.</p>
        <Recovery />
        {inventory.loaded && <>
          <dl className="inventory-summary">
            <div><dt>In-stock spools</dt><dd>{available.length}<small> / {spools.length} total</small></dd></div>
            <div><dt>Filament remaining</dt><dd>{grams(spools.reduce((total, spool) => total + spool.remainingGrams, 0))}</dd></div>
            <div><dt>Running low</dt><dd>{low.length}<small> at 10% or less</small></dd></div>
          </dl>
          {colours.length > 0 && <section className="inventory-colours" aria-label="Available colours"><h3>Available colours <span>({colours.length})</span></h3><div className="inventory-actions">
            {colours.map((spool) => <button key={spool.colour.toUpperCase()} type="button" className="btn inventory-colour-chip" aria-pressed={colour === spool.colour.toUpperCase()} onClick={() => setColour(colour === spool.colour.toUpperCase() ? '' : spool.colour.toUpperCase())}>
              <span className="inventory-dot" style={{ backgroundColor: spool.colour }} />{spool.colourName}
            </button>)}
          </div></section>}
          {spools.length > 0 && <div className="inventory-filters">
            <input className="text" type="search" placeholder="Search spools, colours, brands…" aria-label="Search filament inventory" value={query} onChange={(event) => setQuery(event.target.value)} />
            <Dropdown className="combo" aria-label="Filter by material" value={material} onValueChange={setMaterial} options={[{ value: '', label: 'All materials' }, ...materials.map((value) => ({ value, label: value }))]} />
            <Dropdown className="combo" aria-label="Filter by stock" value={stock} onValueChange={setStock} options={[{ value: 'all', label: 'All spools' }, { value: 'available', label: 'In stock' }, { value: 'low', label: 'Low stock' }, { value: 'empty', label: 'Empty' }]} />
          </div>}
          {(query || material || colour || stock !== 'all') && <div className="inventory-filter-summary"><span>{shown.length} matching spool{shown.length === 1 ? '' : 's'}</span><button type="button" className="btn-ghost" onClick={() => { setQuery(''); setMaterial(''); setColour(''); setStock('all'); }}>Clear filters</button></div>}
          <ul className="inventory-list" aria-label="Filament spools">{shown.map((spool) => <li key={spool.id} className="inventory-spool" data-stock={stockStatus(spool)}>
            <span className="inventory-reel" style={{ borderColor: spool.colour }} aria-hidden="true" />
            <div className="inventory-spool-details"><h3>{spool.name}</h3><p>{[spool.brand, spool.material, spool.colourName].filter(Boolean).join(' · ')}</p>{spool.location && <p className="inventory-location">{spool.location}</p>}</div>
            <div className="inventory-weight"><div><strong>{grams(spool.remainingGrams)}</strong><span>{STATUS[stockStatus(spool)]}</span></div>
              <progress value={spool.remainingGrams} max={spool.capacityGrams} aria-label={`${spool.name}: ${grams(spool.remainingGrams)} of ${grams(spool.capacityGrams)} remaining`} />
              <span>of {grams(spool.capacityGrams)} · {Math.round(spool.remainingGrams / spool.capacityGrams * 100)}% remaining</span>
            </div>
            <div className="inventory-spool-actions"><button type="button" className="btn" disabled={!ready || spool.remainingGrams === 0} aria-label={`Record usage for ${spool.name}`} onClick={() => choose('usage', spool)}>Record usage</button>
              <button type="button" className="btn-ghost" disabled={!ready} aria-label={`Edit ${spool.name}`} onClick={() => choose('edit', spool)}>Edit</button>
              <button type="button" className="btn-ghost" disabled={!ready} aria-label={`Delete ${spool.name}`} onClick={() => choose('delete', spool)}>Delete</button></div>
          </li>)}</ul>
          {!spools.length && <div className="inventory-empty"><h3>No spools yet</h3><p>Add your first spool to see which colours you have and how much filament remains.</p><button type="button" className="btn-primary" disabled={!ready} onClick={() => setSelection({ kind: 'add', revision: inventory.revision })}>Add your first spool</button></div>}
          {spools.length > 0 && !shown.length && <p className="inventory-empty">No spools match these filters.</p>}
        </>}
        {inventory.state === 'loading' && <p role="status">Loading inventory…</p>}
        {inventory.state === 'saving' && <p role="status">Saving inventory…</p>}
      </ModalBody>
      <ModalFooter lead={inventory.loaded ? `${spools.length} spool${spools.length === 1 ? '' : 's'}` : undefined}>
        <button type="button" className="btn" disabled={!ready} onClick={() => void loadInventory()}>Refresh</button>
        <button type="button" className="btn" disabled={busy} onClick={close}>Close</button>
        <button type="button" className="btn-primary" disabled={!ready || spools.length >= 10000} onClick={() => setSelection({ kind: 'add', revision: inventory.revision })}>Add spool</button>
      </ModalFooter>
    </Modal>
    {selection?.kind === 'add' && <SpoolEditor revision={selection.revision} close={() => setSelection(null)} />}
    {selection?.kind === 'edit' && <SpoolEditor spool={selection.spool} revision={selection.revision} close={() => setSelection(null)} />}
    {selection?.kind === 'usage' && <UsageDialog spool={selection.spool} revision={selection.revision} close={() => setSelection(null)} />}
    {selection?.kind === 'delete' && <DeleteDialog spool={selection.spool} revision={selection.revision} close={() => setSelection(null)} />}
  </>;
}
