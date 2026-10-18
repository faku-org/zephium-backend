CREATE TABLE billing_plan_change (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  policy_revision integer NOT NULL REFERENCES cloud_policy(revision),
  quote jsonb NOT NULL,
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','queued','executing','uncertain','applied','scheduled','failed')),
  error_code text,
  attempt_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX billing_plan_change_one_active ON billing_plan_change(user_id)
  WHERE state IN ('queued','executing','uncertain');
CREATE INDEX billing_plan_change_work ON billing_plan_change(next_attempt)
  WHERE state IN ('queued','executing','uncertain');
CREATE INDEX billing_plan_change_user ON billing_plan_change(user_id,created_at DESC);
ALTER TABLE billing_customer ADD COLUMN subscription_checkout_until timestamptz;
ALTER TABLE credit_grant ADD COLUMN allowance_basis bigint CHECK (allowance_basis >= 0);
