import type { BoardTask, BoardUnit, CleaningState } from './types';

export type Grouping = 'floor' | 'type';

export interface BoardFilters {
  state: CleaningState | null;
  /** A floor, `NO_FLOOR` for rooms without one, or null for every floor. */
  floor: string | null;
  mine: boolean;
}

export const NO_FLOOR = '';

export interface UnitGroup {
  key: string;
  label: string;
  units: BoardUnit[];
}

const natural = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function isOpen(task: BoardTask): boolean {
  return task.status === 'pending' || task.status === 'in_progress';
}

export function floorLabel(floor: string | null): string {
  if (floor === null || floor === NO_FLOOR) return 'No floor set';
  return /^-?\d+$/.test(floor) ? `Floor ${floor}` : floor;
}

/** The floors rooms are on, in order. Includes `NO_FLOOR` last when some rooms have none. */
export function floorsOf(units: BoardUnit[]): string[] {
  const floors = [...new Set(units.map((u) => u.floor ?? NO_FLOOR))];
  return floors.sort((a, b) => (a === NO_FLOOR ? 1 : b === NO_FLOOR ? -1 : natural(a, b)));
}

export function filterUnits(
  units: BoardUnit[],
  filters: BoardFilters,
  userId: string,
): BoardUnit[] {
  return units.filter((unit) => {
    if (filters.state && unit.status !== filters.state) return false;
    if (filters.floor !== null && (unit.floor ?? NO_FLOOR) !== filters.floor) return false;
    if (filters.mine && !unit.tasks.some((t) => t.assignedTo === userId)) return false;
    return true;
  });
}

/**
 * Where a room comes within its group: rooms a guest arrives into today that are
 * not ready yet first, then rooms with urgent work, then high priority, then the rest.
 */
export function attention(unit: BoardUnit): number {
  const open = unit.tasks.filter(isOpen);
  if (unit.occupancy === 'turnover' && (open.length > 0 || unit.status === 'dirty')) return 0;
  if (open.some((t) => t.priority === 'urgent')) return 1;
  if (open.some((t) => t.priority === 'high')) return 2;
  return 3;
}

export function groupUnits(units: BoardUnit[], grouping: Grouping): UnitGroup[] {
  const groups = new Map<string, UnitGroup>();
  for (const unit of units) {
    const key = grouping === 'floor' ? (unit.floor ?? NO_FLOOR) : unit.roomTypeName;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: grouping === 'floor' ? floorLabel(key) : key, units: [] };
      groups.set(key, group);
    }
    group.units.push(unit);
  }
  const list = [...groups.values()];
  if (grouping === 'floor') {
    list.sort((a, b) => (a.key === NO_FLOOR ? 1 : b.key === NO_FLOOR ? -1 : natural(a.key, b.key)));
    for (const group of list) group.units.sort((a, b) => natural(a.unitName, b.unitName));
  }
  // The sort is stable, so rooms keep their order within the same level of attention.
  for (const group of list) group.units.sort((a, b) => attention(a) - attention(b));
  return list;
}
