import type { State } from './store';

let guard: ((before: State, after: State) => boolean) | null = null;
let bypass = 0;
export const setEditGuard = (next: typeof guard) => { guard = next; };
export const allowEdit = (before: State, after: State) => bypass > 0 || !guard || guard(before, after);
export function adoptEdit<T>(action: () => T): T {
  bypass++;
  try { return action(); } finally { bypass--; }
}
