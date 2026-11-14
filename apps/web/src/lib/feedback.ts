import type { BlockSaved, RoomChange } from './types';

interface Toaster {
  success(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
}

/** Tells the user what happened to the room when a stay was changed. */
export function announceRoomChange(
  toast: Toaster,
  result: RoomChange,
  message: string,
  detail?: string,
): void {
  if (result.unitReleased) {
    toast.info(
      'Room assignment cleared',
      'The room is taken on the new dates and no other room is free for the whole stay. Assign one before check-in.',
    );
  } else if (result.movedToUnit) {
    toast.info(`Moved to ${result.movedToUnit}`, 'The previous room is taken on the new dates.');
  } else {
    toast.success(message, detail);
  }
}

/** Tells the user which stays were moved to make way for a block. */
export function announceRelocations(toast: Toaster, block: BlockSaved): void {
  if (block.relocated.length === 0) return;
  const moved = block.relocated.filter((r) => r.toUnit !== null);
  const unassigned = block.relocated.filter((r) => r.toUnit === null);
  if (moved.length > 0) {
    toast.info(
      moved.length === 1
        ? `${moved[0]!.guestName} moved to ${moved[0]!.toUnit}`
        : `${moved.length} stays moved to other rooms`,
      moved.length === 1 ? undefined : moved.map((r) => `${r.guestName} to ${r.toUnit}`).join(', '),
    );
  }
  if (unassigned.length > 0) {
    toast.info(
      unassigned.length === 1
        ? `${unassigned[0]!.guestName} now has no room assigned`
        : `${unassigned.length} stays now have no room assigned`,
      'No other room was free for the whole stay. Assign rooms before check-in.',
    );
  }
}
