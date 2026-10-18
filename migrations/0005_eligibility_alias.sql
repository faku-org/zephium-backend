-- Map former or changed email digests to one durable eligibility history.
-- Neither column contains an email address; both are keyed HMAC values.
CREATE TABLE email_eligibility_alias (
 alias_key text PRIMARY KEY REFERENCES email_eligibility(key),
 canonical_key text NOT NULL REFERENCES email_eligibility(key)
);
CREATE INDEX email_eligibility_alias_canonical_idx ON email_eligibility_alias(canonical_key);
