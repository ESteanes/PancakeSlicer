import { documentText } from './wire';

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

const blobIds = new WeakMap<Blob, number>();
let blobSerial = 0;
export function resourceText(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Blob) {
      if (!blobIds.has(item)) blobIds.set(item, ++blobSerial);
      return { blob: blobIds.get(item) };
    }
    if (item && typeof item === 'object' && 'isBufferGeometry' in item && 'uuid' in item) return { geometry: item.uuid };
    if (item instanceof Map) return normalize([...item]);
    if (ArrayBuffer.isView(item)) return JSON.parse(documentText(item)) as unknown;
    if (item instanceof ArrayBuffer) return JSON.parse(documentText(item)) as unknown;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
export const equalResource = (a: unknown, b: unknown) => a === b || resourceText(a) === resourceText(b);

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
