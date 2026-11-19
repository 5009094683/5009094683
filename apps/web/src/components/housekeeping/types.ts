import type { HousekeepingBoard, HousekeepingUnit } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Board = Serialized<HousekeepingBoard>;
export type BoardUnit = Serialized<HousekeepingUnit>;
export type BoardTask = BoardUnit['tasks'][number];
export type CleaningState = BoardUnit['status'];
export type TaskKind = BoardTask['kind'];
export type TaskStatus = BoardTask['status'];
export type Priority = BoardTask['priority'];

/** A state staff set by hand. "Out of service" comes from maintenance taking the room off sale. */
export type SettableState = Exclude<CleaningState, 'out_of_service'>;

/** Someone who can be given work at a property. */
export interface StaffMember {
  id: string;
  name: string;
  roles: string[];
}
