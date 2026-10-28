-- G-Push: Web Push subscription registry
-- Stores browser push subscriptions per principal (user-scoped, not tenant-scoped).

CREATE TABLE IF NOT EXISTS g1.push_subscription (
    subscription_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id    TEXT        NOT NULL,
    endpoint        TEXT        NOT NULL,
    p256dh          TEXT        NOT NULL,
    auth            TEXT        NOT NULL,
    user_agent      TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (principal_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscription_principal_idx
    ON g1.push_subscription (principal_id);
