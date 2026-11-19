-- Erasing a guest's personal data has to take their name out of the wording of
-- audit entries about them. That is the one change an audit entry may ever
-- undergo: only its summary and its recorded field changes, only inside a
-- transaction that announces the redaction. Who did what, to what, and when
-- stays exactly as it was written.
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pms.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('pms.audit_redaction', true) = 'on'
     AND NEW.id = OLD.id
     AND NEW.org_id = OLD.org_id
     AND NEW.at = OLD.at
     AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
     AND NEW.actor_label = OLD.actor_label
     AND NEW.action = OLD.action
     AND NEW.entity_type = OLD.entity_type
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.property_id IS NOT DISTINCT FROM OLD.property_id
     AND NEW.ip IS NOT DISTINCT FROM OLD.ip
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = '42501';
END $$;
