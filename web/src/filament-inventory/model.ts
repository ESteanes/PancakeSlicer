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
}

export const grams = (weight: number) => `${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} g`;
export const stockStatus = (spool: Spool) => spool.remainingGrams === 0 ? 'empty' : spool.remainingGrams <= spool.capacityGrams * 0.1 ? 'low' : 'available';

export function spoolError(spool: Spool): string | null {
  if (typeof spool.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(spool.id) || spool.id === '.' || spool.id === '..') return 'Invalid spool ID.';
  for (const [key, label] of [['name', 'Spool name'], ['material', 'Material'], ['colourName', 'Colour name']] as const) {
    if (typeof spool[key] !== 'string' || !spool[key].trim() || spool[key].length > 100) return `${label} is required (up to 100 characters).`;
  }
  if (typeof spool.brand !== 'string' || spool.brand.length > 100 || typeof spool.location !== 'string' || spool.location.length > 200) return 'Brand or location is too long.';
  if (typeof spool.colour !== 'string' || !/^#[\da-f]{6}$/i.test(spool.colour)) return 'Enter a 6-digit HEX colour, such as #FF6B00.';
  if (!Number.isFinite(spool.capacityGrams) || spool.capacityGrams <= 0 || spool.capacityGrams > 1000000) return 'Capacity must be greater than zero and no more than 1,000,000 g.';
  if (!Number.isFinite(spool.remainingGrams) || spool.remainingGrams < 0 || spool.remainingGrams > spool.capacityGrams) return 'Remaining weight must be between zero and the spool capacity.';
  return null;
}

