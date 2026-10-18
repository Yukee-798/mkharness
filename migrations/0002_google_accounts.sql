-- Retire browser-only identities without deleting users or their owned data.
-- Apply before deploying Google-only authentication. Keep Google account sessions.
DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE isAnonymous = 1);
ALTER TABLE user DROP COLUMN isAnonymous;
