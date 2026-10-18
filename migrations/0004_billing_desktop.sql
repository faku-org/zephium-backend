-- A returned checkout is bound to its initiating account, product, and policy revision.
-- Refresh only queries orders for these known checkout IDs.
CREATE TABLE billing_checkout (
 checkout_id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 product_id text NOT NULL,
 policy_revision integer REFERENCES cloud_policy(revision),
 kind text NOT NULL CHECK (kind IN ('subscription','topup')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_checkout_user_created ON billing_checkout(user_id,created_at DESC);
