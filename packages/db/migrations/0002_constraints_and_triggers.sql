-- One physical unit cannot hold two overlapping stays or blocks. This is the
-- last line of defence against a double booking: it holds no matter which
-- code path, script or manual query writes the row.
ALTER TABLE unit_occupancy ADD CONSTRAINT unit_no_overlap
  EXCLUDE USING gist (unit_id WITH =, stay WITH &&);
--> statement-breakpoint

-- Occupancy is always recorded on atomic units. Booking a unit that has
-- children must be expanded into one row per child by the caller; a row on the
-- parent itself would not conflict with its children and is rejected.
CREATE FUNCTION unit_occupancy_atomic_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM units c WHERE c.parent_unit_id = NEW.unit_id AND c.active) THEN
    RAISE EXCEPTION 'occupancy must be recorded on the child units of %', NEW.unit_id
      USING ERRCODE = '23514', CONSTRAINT = 'unit_occupancy_atomic';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER unit_occupancy_atomic BEFORE INSERT OR UPDATE OF unit_id ON unit_occupancy
  FOR EACH ROW EXECUTE FUNCTION unit_occupancy_atomic_guard();
--> statement-breakpoint

-- Linked units form a tree exactly one level deep, inside one property. The
-- inventory arithmetic relies on this.
CREATE FUNCTION units_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent units%ROWTYPE;
BEGIN
  IF NEW.parent_unit_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM units WHERE id = NEW.parent_unit_id;
  IF parent.property_id <> NEW.property_id THEN
    RAISE EXCEPTION 'linked units must belong to the same property'
      USING ERRCODE = '23514', CONSTRAINT = 'units_link_same_property';
  END IF;
  IF parent.parent_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'a linked unit cannot be the parent of another unit'
      USING ERRCODE = '23514', CONSTRAINT = 'units_link_depth';
  END IF;
  IF EXISTS (SELECT 1 FROM units c WHERE c.parent_unit_id = NEW.id) THEN
    RAISE EXCEPTION 'a unit that has linked children cannot itself be linked to a parent'
      USING ERRCODE = '23514', CONSTRAINT = 'units_link_depth';
  END IF;
  IF parent.room_type_id = NEW.room_type_id THEN
    RAISE EXCEPTION 'a linked unit must be of a different room type than its parent'
      USING ERRCODE = '23514', CONSTRAINT = 'units_link_distinct_type';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER units_link BEFORE INSERT OR UPDATE OF parent_unit_id, property_id, room_type_id ON units
  FOR EACH ROW EXECUTE FUNCTION units_link_guard();
--> statement-breakpoint

-- Wake listeners (the sync worker, the API's live-update stream) the moment a
-- change commits. Notifications are transactional: they are delivered only if
-- the transaction that wrote the outbox row commits.
CREATE FUNCTION outbox_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  message := json_build_object(
    'id', NEW.id, 'kind', NEW.kind, 'orgId', NEW.org_id,
    'propertyId', NEW.property_id, 'payload', NEW.payload)::text;
  -- NOTIFY payloads are limited to 8000 bytes; listeners can re-read by id.
  IF octet_length(message) > 7000 THEN
    message := json_build_object(
      'id', NEW.id, 'kind', NEW.kind, 'orgId', NEW.org_id,
      'propertyId', NEW.property_id, 'truncated', true)::text;
  END IF;
  PERFORM pg_notify('pms_outbox', message);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();
--> statement-breakpoint

CREATE FUNCTION jobs_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('pms_jobs', NEW.kind);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER jobs_notify AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_notify();
--> statement-breakpoint

-- The audit log is append-only. Rows can never be changed. They can be deleted
-- only by the retention job, which announces itself with a transaction-local
-- setting, so an ordinary DELETE (or a compromised query path) is refused.
CREATE FUNCTION audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pms.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
--> statement-breakpoint
CREATE FUNCTION audit_log_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_truncate_guard();
