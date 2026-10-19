-- Profile fields on principals (populated from IdP claims at login)
ALTER TABLE g1.principals
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS email        TEXT;
