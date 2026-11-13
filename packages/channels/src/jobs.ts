/** Background job kinds the sync engine queues. The API queues some; the worker runs them all. */
export const CHANNEL_JOBS = {
  /** Fetch waiting bookings for one connection. Payload: `{ connectionId, via }`. */
  pull: 'channel.pull',
  /** Compare the channel's values with the PMS for one connection. Payload: `{ connectionId }`. */
  driftCheck: 'channel.drift_check',
  /** Bring in bookings made before the connection existed. Payload: `{ connectionId }`. */
  importBookings: 'channel.import_bookings',
  /** Read one guest conversation into the inbox. Payload: `{ connectionId, threadId }`. */
  pullMessages: 'channel.pull_messages',
} as const;
