import type { BlockKind } from '@pms/db';

export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  block: 'Blocked',
  maintenance: 'Out of order',
  owner_stay: 'Owner stay',
  hold: 'Held',
};
