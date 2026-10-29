from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from shared.db import db_connection, db_tenant_connection
from api.routers.api_keys import _tenant_ctx, _require_admin

router = APIRouter(prefix="/api/v1/feature-flags", tags=["feature-flags"])


class FlagUpdate(BaseModel):
    enabled: bool


@router.get("")
async def list_flags(request: Request):
    tenant_id, _ = _tenant_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT flag_id, flag_key, enabled, description, updated_at, updated_by
              FROM g1.feature_flag
             WHERE tenant_id = %s
             ORDER BY flag_key
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in cur.description]
        rows = await cur.fetchall()
    return [dict(zip(cols, r)) for r in rows]


@router.get("/check/{flag_key}")
async def check_flag(flag_key: str, request: Request):
    tenant_id, _ = _tenant_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT enabled FROM g1.feature_flag WHERE tenant_id = %s AND flag_key = %s",
            (tenant_id, flag_key),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="flag not found")
    return {"flag_key": flag_key, "enabled": bool(row[0])}


@router.put("/{flag_key}")
async def update_flag(flag_key: str, body: FlagUpdate, request: Request):
    tenant_id, principal_id = await _require_admin(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.feature_flag
                (tenant_id, flag_key, enabled, updated_at, updated_by)
            VALUES (%s, %s, %s, NOW(), %s)
            ON CONFLICT (tenant_id, flag_key) DO UPDATE
                SET enabled    = EXCLUDED.enabled,
                    updated_at = NOW(),
                    updated_by = EXCLUDED.updated_by
            RETURNING flag_id, flag_key, enabled, updated_at, updated_by
            """,
            (tenant_id, flag_key, body.enabled, principal_id),
        )
        cols = [d[0] for d in cur.description]
        row = await cur.fetchone()
        await conn.commit()
    return dict(zip(cols, row))


@router.post("/reset")
async def reset_flags(request: Request):
    """Re-seed default flags that may be missing for this tenant."""
    tenant_id, principal_id = await _require_admin(request)
    defaults = [
        ("module_aiops",          True,  "AIOps e análise inteligente"),
        ("module_finops",         True,  "FinOps e gestão de custos"),
        ("module_synthetic",      True,  "Monitoramento sintético"),
        ("module_oncall",         True,  "Gestão de plantão"),
        ("module_kb",             True,  "Base de conhecimento"),
        ("module_drift",          True,  "Config drift detection"),
        ("module_executive",      True,  "Executive dashboard"),
        ("module_reports",        True,  "Relatórios agendados"),
        ("module_automation",     True,  "Automação e scripts"),
        ("module_sla",            True,  "SLA e serviços"),
        ("module_maintenance",    True,  "Janelas de manutenção"),
        ("module_chatops",        False, "Integração Slack/Teams (beta)"),
        ("module_push",           False, "Notificações push (beta)"),
        ("module_client_portal",  False, "Portal do cliente (beta)"),
    ]
    inserted = 0
    async with db_tenant_connection(tenant_id) as conn:
        for flag_key, enabled, description in defaults:
            cur = await conn.execute(
                """
                INSERT INTO g1.feature_flag
                    (tenant_id, flag_key, enabled, description, updated_by)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, flag_key) DO NOTHING
                """,
                (tenant_id, flag_key, enabled, description, principal_id),
            )
            if cur.rowcount == 1:
                inserted += 1
        await conn.commit()
    return {"inserted": inserted, "tenant_id": tenant_id}
