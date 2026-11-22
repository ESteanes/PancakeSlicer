export interface Spool {
  id: string;
  name: string;
  brand: string;
  material: string;
  colour: string;
  colourName: string;
  capacityGrams: number;
  remainingGrams: number;
  location: string;
  diameterMm?: number;
  densityGramsCm3?: number;
}

export const grams = (weight: number) => `${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} g`;
export const metres = (length: number) => `${length.toLocaleString(undefined, { maximumFractionDigits: 2 })} m`;
export const materialKey = (value: string) => value.trim().toUpperCase();
export const stockStatus = (spool: Spool) => spool.remainingGrams === 0 ? 'empty' : spool.remainingGrams <= spool.capacityGrams * 0.1 ? 'low' : 'available';

type Dimensions = Pick<Spool, 'diameterMm' | 'densityGramsCm3'>;
export function dimensionError(spool: Dimensions): string | null {
  if (spool.diameterMm !== undefined && (!Number.isFinite(spool.diameterMm) || spool.diameterMm <= 0 || spool.diameterMm > 10)) return 'Diameter must be greater than zero and no more than 10 mm.';
  if (spool.densityGramsCm3 !== undefined && (!Number.isFinite(spool.densityGramsCm3) || spool.densityGramsCm3 <= 0 || spool.densityGramsCm3 > 30)) return 'Density must be greater than zero and no more than 30 g/cm³.';
  return null;
}
export function gramsPerMetre(spool: Dimensions): number | null {
  if (dimensionError(spool) || spool.diameterMm === undefined || spool.densityGramsCm3 === undefined) return null;
  return Math.PI * (spool.diameterMm / 2) ** 2 * spool.densityGramsCm3;
}

export interface FilamentUsage { slot: number; grams: number }
export interface SpoolAssignment { slot: number; spoolId: string }
export interface PrintRequest { printId: string; jobId: string; name: string; expectedRevision: number; assignments: SpoolAssignment[] }
export interface PrintRecord { id: string; jobId: string; name: string; at: number; usage: { spoolId: string; name: string; grams: number }[] }

export function sliceFilamentUsage(record: unknown): FilamentUsage[] | null {
  const rows = (record as { statistics?: { per_extruder?: unknown } } | null)?.statistics?.per_extruder;
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) return null;
  const seen = new Set<number>(), usage: FilamentUsage[] = [];
  for (const row of rows) {
    if (!row || !Number.isInteger(row.extruder_id) || row.extruder_id < 0 || row.extruder_id > 255 || seen.has(row.extruder_id)
      || typeof row.used_filament_g !== 'number' || !Number.isFinite(row.used_filament_g) || row.used_filament_g < 0 || row.used_filament_g > 1000000) return null;
    seen.add(row.extruder_id);
    if (row.used_filament_g > 0) usage.push({ slot: row.extruder_id, grams: row.used_filament_g });
  }
  return usage.length ? usage.sort((a, b) => a.slot - b.slot) : null;
}

export function spoolUsage(usage: FilamentUsage[], assignments: SpoolAssignment[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of usage) {
    const id = assignments.find((assignment) => assignment.slot === row.slot)?.spoolId;
    if (id) totals.set(id, (totals.get(id) ?? 0) + row.grams);
  }
  return new Map([...totals].map(([id, weight]) => [id, Math.ceil(weight * 1000) / 1000]));
}

export function spoolError(spool: Spool): string | null {
  if (typeof spool.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(spool.id) || spool.id === '.' || spool.id === '..') return 'Invalid spool ID.';
  for (const [key, label] of [['name', 'Spool name'], ['material', 'Material'], ['colourName', 'Colour name']] as const) {
    if (typeof spool[key] !== 'string' || !spool[key].trim() || spool[key].length > 100) return `${label} is required (up to 100 characters).`;
  }
  if (typeof spool.brand !== 'string' || spool.brand.length > 100 || typeof spool.location !== 'string' || spool.location.length > 200) return 'Brand or location is too long.';
  if (typeof spool.colour !== 'string' || !/^#[\da-f]{6}$/i.test(spool.colour)) return 'Enter a 6-digit HEX colour, such as #FF6B00.';
  if (!Number.isFinite(spool.capacityGrams) || spool.capacityGrams <= 0 || spool.capacityGrams > 1000000) return 'Capacity must be greater than zero and no more than 1,000,000 g.';
  if (!Number.isFinite(spool.remainingGrams) || spool.remainingGrams < 0 || spool.remainingGrams > spool.capacityGrams) return 'Remaining weight must be between zero and the spool capacity.';
  return dimensionError(spool);
}

