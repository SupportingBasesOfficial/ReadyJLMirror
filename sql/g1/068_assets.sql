-- 068_assets.sql

CREATE TABLE g1.asset (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    asset_type      TEXT NOT NULL
                        CHECK (asset_type IN ('hardware', 'software', 'license')),
    category        TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive', 'retired', 'disposed')),
    -- hardware
    manufacturer    TEXT,
    model           TEXT,
    serial_number   TEXT,
    location        TEXT,
    purchase_date   DATE,
    warranty_expiry DATE,
    -- software
    version         TEXT,
    installed_on    TEXT,
    -- license
    vendor          TEXT,
    license_key     TEXT,
    seats_total     INT,
    seats_used      INT,
    expiry_date     DATE,
    -- common
    assigned_to     UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notes           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ON g1.asset (tenant_id, serial_number)
    WHERE serial_number IS NOT NULL;
CREATE INDEX ON g1.asset (tenant_id, asset_type);
CREATE INDEX ON g1.asset (tenant_id, status);
CREATE INDEX ON g1.asset (tenant_id, expiry_date)
    WHERE expiry_date IS NOT NULL;
CREATE INDEX ON g1.asset (tenant_id, created_at DESC);
