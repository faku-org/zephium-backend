-- Grant grouping is separate from login identity and its email-change aliases.
-- Do not rewrite existing eligibility keys or credit grants.
CREATE TABLE grant_eligibility_group (
 key text PRIMARY KEY,
 welcome_claimed_at timestamptz,
 signup_claimed_at timestamptz,
 free_anchor timestamptz,
 free_period_end timestamptz
);
CREATE TABLE grant_eligibility_member (
 identity_key text PRIMARY KEY REFERENCES email_eligibility(key),
 group_key text NOT NULL REFERENCES grant_eligibility_group(key)
);
CREATE INDEX grant_eligibility_member_group_idx ON grant_eligibility_member(group_key);
CREATE TABLE grant_eligibility_mailbox (
 mailbox_key text PRIMARY KEY,
 group_key text NOT NULL REFERENCES grant_eligibility_group(key)
);
CREATE INDEX grant_eligibility_mailbox_group_idx ON grant_eligibility_mailbox(group_key);
CREATE TABLE grant_eligibility_migration (
 version integer PRIMARY KEY CHECK (version=1),
 complete boolean NOT NULL
);
-- Existing addresses require a secret-bearing application backfill, not SQL normalization.
INSERT INTO grant_eligibility_migration(version,complete)
 VALUES (1,NOT EXISTS(SELECT 1 FROM auth_user));
