import type { ActorType, Role } from '@pms/db';

export interface Grant {
  role: Role;
  /** Null means the role applies to every property. */
  propertyId: string | null;
}

/** Who is performing an action. Recorded on every audit entry. */
export interface Actor {
  type: ActorType;
  orgId: string;
  userId?: string;
  /** Email, API key name, channel code or component name. */
  label: string;
  grants: Grant[];
  ip?: string;
  requestId?: string;
}

export function systemActor(orgId: string, component: string): Actor {
  return { type: 'system', orgId, label: `system:${component}`, grants: [] };
}

export function channelActor(orgId: string, channel: string): Actor {
  return { type: 'channel', orgId, label: `channel:${channel}`, grants: [] };
}
