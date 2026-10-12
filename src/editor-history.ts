import type { Graph } from '../shared/model';
export interface EditHistory { revision: number; undo: Graph[]; redo: Graph[] }
export const newEditHistory = (revision: number): EditHistory => ({ revision, undo: [], redo: [] });
export function recordEdit(history: EditHistory, before: Graph, after: Graph, revision: number): EditHistory {
  if (JSON.stringify(before) === JSON.stringify(after)) return { ...history, revision };
  return { revision, undo: [...history.undo, before], redo: [] };
}
function move(history: EditHistory, revision: number, direction: 'undo' | 'redo', current?: Graph) {
  if (history.revision !== revision) throw new Error('The design changed outside this editing history. Reload and reconcile before undoing.');
  const graph = history[direction].at(-1);
  if (!graph) throw new Error(`Nothing to ${direction}.`);
  const opposite = direction === 'undo' ? 'redo' : 'undo';
  return { graph, history: { ...history, revision: revision + 1, [direction]: history[direction].slice(0, -1), [opposite]: [...history[opposite], ...(current ? [current] : [])] } };
}
export const undoEdit = (history: EditHistory, revision: number, current?: Graph) => move(history, revision, 'undo', current);
export const redoEdit = (history: EditHistory, revision: number, current?: Graph) => move(history, revision, 'redo', current);
