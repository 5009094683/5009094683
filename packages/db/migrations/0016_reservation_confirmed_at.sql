ALTER TABLE "reservations" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Every booking so far was firm from the moment it was made, or within minutes of it (a website
-- booking is held only while the guest pays). Holds that are still open, and those that lapsed
-- without ever becoming a booking, have no such moment.
UPDATE "reservations"
SET "confirmed_at" = "created_at"
WHERE "status" <> 'tentative'
  AND coalesce("cancellation_reason", '') NOT IN (
    'Hold expired before the booking was completed',
    'The payment page could not be opened'
  );
