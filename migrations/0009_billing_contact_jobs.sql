CREATE TABLE billing_contact_job (
  user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  requested integer NOT NULL DEFAULT 1 CHECK (requested >= 0),
  processed integer NOT NULL DEFAULT 0 CHECK (processed >= 0 AND processed <= requested),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_contact_job_work ON billing_contact_job(next_attempt)
  WHERE requested > processed AND attempts < 10;
-- Repair existing provider relationships without copying addresses into queue payloads.
INSERT INTO billing_contact_job(user_id)
  SELECT b.user_id FROM billing_customer b JOIN auth_user u ON u.id=b.user_id
  WHERE u.lifecycle='active' AND u.email_verified AND (b.provider_touched OR b.polar_id IS NOT NULL);
