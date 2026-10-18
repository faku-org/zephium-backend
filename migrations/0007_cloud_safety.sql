ALTER TABLE email_eligibility ADD COLUMN signup_claimed_at timestamptz;
-- Existing free grants count as an already claimed trial during migration.
UPDATE email_eligibility SET signup_claimed_at=coalesce(welcome_claimed_at,free_anchor) WHERE welcome_claimed_at IS NOT NULL OR free_anchor IS NOT NULL;
ALTER TABLE cloud_request ADD COLUMN cost_rates jsonb;
ALTER TABLE cloud_request ADD COLUMN dispatched_at timestamptz;
ALTER TABLE cloud_request ADD COLUMN reserved_at timestamptz;
CREATE TABLE cloud_spend_bucket (
 key text PRIMARY KEY,
 amount bigint NOT NULL DEFAULT 0 CHECK(amount >= 0)
);
-- No account foreign key: account deletion must not reset deployment spending.
-- No customer identity, prompt, output, or audio is retained here.
CREATE TABLE cloud_cost_record (
 request_id uuid PRIMARY KEY,
 scope text NOT NULL,
 day date NOT NULL,
 reserved bigint NOT NULL CHECK(reserved >= 0),
 exposure bigint NOT NULL CHECK(exposure >= 0),
 free_reserved bigint NOT NULL CHECK(free_reserved >= 0),
 free_exposure bigint NOT NULL CHECK(free_exposure >= 0),
 terminal boolean NOT NULL DEFAULT false
);

ALTER TABLE cloud_request ADD COLUMN plan_id text;
CREATE INDEX cloud_request_daily ON cloud_request(user_id,started_at);
CREATE INDEX cloud_request_global_live ON cloud_request(lease_until) WHERE state IN ('preflight','reserved','running');

ALTER TABLE cloud_request ADD COLUMN funding_source text CHECK(funding_source IN ('allowance','purchased','mixed'));

CREATE INDEX cloud_request_reserved_day ON cloud_request(user_id,(coalesce(reserved_at,started_at)));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN
    REVOKE INSERT,UPDATE,DELETE ON cloud_policy,cloud_active_policy FROM zephium_app;
  END IF;
END $$;
