ALTER TABLE "reservation_groups" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "reservation_groups" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "inventory_blocks_group_idx" ON "inventory_blocks" USING btree ("group_id") WHERE group_id IS NOT NULL AND released_at IS NULL;--> statement-breakpoint
CREATE INDEX "reservation_groups_property_status_idx" ON "reservation_groups" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "reservations_group_idx" ON "reservations" USING btree ("group_id") WHERE group_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "reservation_groups" ADD CONSTRAINT "reservation_groups_status_check" CHECK (status IN ('open','closed','cancelled'));