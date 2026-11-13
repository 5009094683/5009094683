-- Both extensions are "trusted" in PostgreSQL 13+, so the database owner can
-- create them without superuser rights.
-- btree_gist: lets an exclusion constraint combine `unit_id =` with a date-range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- citext: case-insensitive email columns.
CREATE EXTENSION IF NOT EXISTS citext;
