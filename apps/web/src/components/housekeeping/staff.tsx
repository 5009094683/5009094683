import { ROLE_PERMISSIONS, type Permission } from '@pms/domain/shared';
import type { StaffMember } from './types';

/** The two kinds of work the staff list of a property is for. Each is also the name of a role. */
export type WorkArea = 'housekeeping' | 'maintenance';

const AREAS: Record<WorkArea, { permission: Permission; label: string }> = {
  housekeeping: { permission: 'housekeeping.write', label: 'Housekeeping' },
  maintenance: { permission: 'maintenance.write', label: 'Maintenance' },
};

const ROLES: Record<string, readonly Permission[] | undefined> = ROLE_PERMISSIONS;

/** The people who can do this kind of work, out of everyone who can be given work at the property. */
export function staffFor(staff: StaffMember[], area: WorkArea): StaffMember[] {
  const { permission } = AREAS[area];
  return staff.filter((person) => person.roles.some((role) => ROLES[role]?.includes(permission)));
}

/**
 * The choices for "who does this": the people whose job it is first, then other
 * staff who may do it. Someone already on the work stays a choice even if they
 * have since left the list.
 */
export function PersonOptions({
  staff,
  area,
  current,
}: {
  staff: StaffMember[];
  area: WorkArea;
  current?: { id: string | null; name: string | null };
}) {
  const own = staff.filter((person) => person.roles.includes(area));
  const others = staff.filter((person) => !person.roles.includes(area));
  const missing = current?.id && !staff.some((person) => person.id === current.id);
  const options = (people: StaffMember[]) =>
    people.map((person) => (
      <option key={person.id} value={person.id}>
        {person.name}
      </option>
    ));
  return (
    <>
      <option value="">Not assigned</option>
      {own.length > 0 && others.length > 0 ? (
        <>
          <optgroup label={AREAS[area].label}>{options(own)}</optgroup>
          <optgroup label="Other staff">{options(others)}</optgroup>
        </>
      ) : (
        options(staff)
      )}
      {missing && (
        <option value={current.id ?? ''}>{current.name ?? 'No longer on the list'}</option>
      )}
    </>
  );
}
