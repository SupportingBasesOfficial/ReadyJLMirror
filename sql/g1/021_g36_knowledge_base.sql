-- G36 Knowledge Base — articles, categories, full-text search, incident links.

BEGIN;

-- ── Categories ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.kb_category (
    category_id TEXT        PRIMARY KEY,  -- 'kbc:<uuid>'
    tenant_id   TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    name        TEXT        NOT NULL CHECK (name <> ''),
    parent_id   TEXT        REFERENCES g1.kb_category(category_id),
    slug        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

-- ── Articles ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.kb_article (
    article_id  TEXT        PRIMARY KEY,  -- 'kba:<uuid>'
    tenant_id   TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    category_id TEXT        REFERENCES g1.kb_category(category_id),
    title       TEXT        NOT NULL CHECK (title <> ''),
    body        TEXT        NOT NULL DEFAULT '',
    status      TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
    tags        TEXT[]      NOT NULL DEFAULT '{}',
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_article_tenant_status
    ON g1.kb_article (tenant_id, status, updated_at DESC);

-- Full-text search index over combined title + body text
CREATE INDEX IF NOT EXISTS kb_article_fts
    ON g1.kb_article
    USING GIN (
        to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
    );

-- ── Incident links ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.kb_article_incident (
    article_id  TEXT        NOT NULL REFERENCES g1.kb_article(article_id) ON DELETE CASCADE,
    incident_id TEXT        NOT NULL,
    tenant_id   TEXT        NOT NULL,
    linked_by   TEXT        NOT NULL,
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (article_id, incident_id)
);

-- ── Grants ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.kb_category TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.kb_article TO jlmirror_app;
GRANT SELECT, INSERT, DELETE ON g1.kb_article_incident TO jlmirror_app;

COMMIT;
