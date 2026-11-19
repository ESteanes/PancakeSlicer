export type SharedObject = { id: number; [key: string]: unknown };
export type SharedPlate = { index: number; objects?: SharedObject[]; events?: unknown[]; [key: string]: unknown };
export interface SharedDocument {
  objects: SharedObject[];
  projectPlates: SharedPlate[];
  plateIndex: number;
  events: unknown[];
  files?: Record<string, string>;
  collaborationOrder?: Record<string, number>;
  [key: string]: unknown;
}
export interface ObjectResource { plate: number; order: number; object: SharedObject }
export interface SettingsResource { fields: Record<string, unknown>; plates: SharedPlate[] }
export type Resources = Record<string, ObjectResource | SettingsResource>;
export interface ResourceChange { key: string; before: ObjectResource | SettingsResource | null; after: ObjectResource | SettingsResource | null; token?: string }

export function equalResource(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Blob || b instanceof Blob) return false;
  if ('isBufferGeometry' in a || 'isBufferGeometry' in b)
    return 'uuid' in a && 'uuid' in b && a.uuid === b.uuid;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !equalResource(value, b.get(key))) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof ArrayBuffer) {
    if (a.constructor.name !== b.constructor.name) return false;
    const bytes = (value: object) => value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    const x = bytes(a), y = bytes(b);
    if (!x || !y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => equalResource(value, b[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => x[key] !== undefined);
  return keys.length === Object.keys(y).filter(key => y[key] !== undefined).length && keys.every(key => Object.hasOwn(y, key) && equalResource(x[key], y[key]));
}

export function splitShared(input: unknown, base?: Resources): Resources {
  const doc = input as SharedDocument;
  const { objects, projectPlates, plateIndex, selected: _selected, events, files: _files,
    recoveryCheckpoint: _checkpoint, collaborationOrder: orders, projectNotice: _notice, ...fields } = doc;
  const plates = projectPlates.length ? projectPlates.map(p => p.index === plateIndex ? { ...p, objects, events } : p)
    : [{ index: plateIndex || 1, name: '', origin: [0, 0], settings: {}, objects, events }];
  const out: Resources = {};
  for (const plate of plates) {
    const list = plate.objects ?? [];
    const previous = (o: SharedObject, i: number) => {
      const old = base?.[`object:${o.id}`] as ObjectResource | undefined;
      return old?.plate === plate.index ? old.order : orders?.[String(o.id)] ?? (base ? undefined : i + 1);
    };
    let last = 0, lastId = 0;
    for (let i = 0; i < list.length; i++) {
      const object = list[i];
      let order = previous(object, i);
      if (order === undefined || base && (order < last || order === last && object.id < lastId)) {
        const next = list.slice(i + 1).map((o, j) => previous(o, i + 1 + j)).find(n => n !== undefined && n > last);
        order = next === undefined ? last + 1 : (last + next) / 2;
      }
      out[`object:${object.id}`] = { plate: plate.index, order, object };
      last = order;
      lastId = object.id;
    }
  }
  out.settings = { fields, plates: plates.map(({ objects: _objects, ...plate }) => ({ ...plate, events: plate.events ?? [] })) };
  return out;
}

export function joinShared(resources: Resources, personal: unknown): SharedDocument {
  const local = personal as SharedDocument;
  const settings = resources.settings as SettingsResource;
  const entries = Object.entries(resources).filter(([key]) => key !== 'settings').map(([, value]) => value as ObjectResource)
    .sort((a, b) => a.order - b.order || a.object.id - b.object.id);
  const plates = settings.plates.map(p => ({ ...p, objects: entries.filter(o => o.plate === p.index).map(o => o.object) }));
  const active = plates.find(p => p.index === local.plateIndex) ?? plates[0];
  return { ...settings.fields, projectPlates: plates, plateIndex: active.index, objects: active.objects, events: active.events ?? [],
    selected: local.selected ?? null, projectNotice: local.projectNotice ?? null, files: local.files,
    collaborationOrder: Object.fromEntries(entries.map(o => [String(o.object.id), o.order])) } as SharedDocument;
}

export function selectSharedPlate<T extends { plateIndex: number; objects: unknown[]; events: unknown[];
  projectPlates: { index: number; objects?: unknown[]; events?: unknown[] }[] }>(doc: T, index: number): T {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('The saved slice has no valid plate information. Slice the project again.');
  if (doc.plateIndex === index) return doc;
  const plates = doc.projectPlates.map(p => p.index === doc.plateIndex ? { ...p, objects: doc.objects, events: doc.events } : p);
  const plate = plates.find(p => p.index === index);
  if (!plate) throw new Error('The sliced plate is missing from this project version.');
  return { ...doc, projectPlates: plates, plateIndex: index, objects: plate.objects ?? [], events: plate.events ?? [], selected: null };
}

export function historyChange(from: unknown, to: unknown, personal: unknown) {
  const before = splitShared(from), after = splitShared(to, before), changes = sharedChanges(before, after);
  const current = splitShared(personal, before), target = to as SharedDocument, local = personal as SharedDocument;
  if (changes.some(change => !equalResource(current[change.key] ?? null, change.before))) return null;
  let doc = joinShared(applyShared(current, changes), local);
  if ((from as SharedDocument).plateIndex !== target.plateIndex) {
    if (!doc.projectPlates.some(p => p.index === target.plateIndex)) return null;
    doc = { ...selectSharedPlate(doc, target.plateIndex), selected: target.selected };
  }
  return { doc, changes };
}

export function sharedChanges(before: Resources, after: Resources): ResourceChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    const a = before[key] ?? null, b = after[key] ?? null;
    return equalResource(a, b) ? [] : [{ key, before: a, after: b }];
  });
}

export function applyShared(resources: Resources, changes: ResourceChange[]): Resources {
  const next = { ...resources };
  for (const change of changes) {
    if (change.after === null) delete next[change.key];
    else next[change.key] = change.after;
  }
  return next;
}
