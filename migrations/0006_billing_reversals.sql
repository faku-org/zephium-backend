-- A refund is terminal, including when observed before its first paid grant.
CREATE TABLE billing_order_reversal (
 order_id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 product_id text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_order_reversal_user ON billing_order_reversal(user_id);
