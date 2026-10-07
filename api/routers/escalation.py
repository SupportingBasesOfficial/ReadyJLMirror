"""G23 Escalation Policies — time-based multi-step alert escalation.

Operators define policies (a name + ordered steps). Each step specifies
a delay (minutes since the prior step fired) and a notification destination.
When a policy is armed on an alert, the escalation worker fires notifications
step-by-step until the alert resolves or all steps are exhausted.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["escalation"])

_APP_ROLE    = "jlmirror_g23_esc_app_invoker"
_CHANNELS    = ("whatsapp_business@1", "email_smtp@1", "slack@1")


def _ser(row) -> dict:
    out = dict(row)
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


# ─── Policy CRUD ──────────────────────────────────────────────────────────────

class PolicyCreate(BaseModel):
    name: str
    description: str | None = None


@router.get("/escalation-policies")
async def list_policies(request: Request,
                        tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT ep.policy_id, ep.name, ep.description, ep.created_at,
                   (SELECT apv.policy_id
                      FROM alerting.alert_policy_version apv
                     WHERE apv.escalation_policy_id = ep.policy_id
                       AND apv.tenant_id = %s
                     LIMIT 1) AS linked_alert_policy_id
              FROM alerting.escalation_policy ep
             WHERE ep.tenant_id = %s AND ep.deleted_at IS NULL
             ORDER BY ep.created_at DESC
            """, (tenant, tenant))
        cols = [d.name for d in cur.description]
        return [_ser(dict(zip(cols, r))) for r in await cur.fetchall()]


class PolicyPatch(BaseModel):
    linked_alert_policy_id: str | None = None


@router.patch("/escalation-policies/{policy_id}",
              status_code=status.HTTP_200_OK)
async def patch_policy(policy_id: str, request: Request,
                       body: PolicyPatch,
                       tenant_id: str | None = None) -> dict:
    """Link (or unlink) an alert policy to this escalation policy."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
        # Verify the escalation policy exists for this tenant.
        cur = await conn.execute(
            "SELECT 1 FROM alerting.escalation_policy "
            "WHERE policy_id = %s AND tenant_id = %s AND deleted_at IS NULL",
            (policy_id, tenant))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="policy not found")
        # Update the alert_policy_version row(s) for the given alert policy.
        if body.linked_alert_policy_id is not None:
            # Clear any existing link for this escalation policy first.
            await conn.execute(
                """
                UPDATE alerting.alert_policy_version
                   SET escalation_policy_id = NULL
                 WHERE escalation_policy_id = %s AND tenant_id = %s
                """, (policy_id, tenant))
            # Set the new link on the alert policy's latest version.
            await conn.execute(
                """
                UPDATE alerting.alert_policy_version
                   SET escalation_policy_id = %s
                 WHERE policy_id = %s AND tenant_id = %s
                   AND superseded_at IS NULL
                """, (policy_id, body.linked_alert_policy_id, tenant))
        else:
            # Unlink: clear escalation_policy_id for all versions of any
            # alert policy currently pointing at this escalation policy.
            await conn.execute(
                """
                UPDATE alerting.alert_policy_version
                   SET escalation_policy_id = NULL
                 WHERE escalation_policy_id = %s AND tenant_id = %s
                """, (policy_id, tenant))
        await conn.commit()
    return {"policy_id": policy_id,
            "linked_alert_policy_id": body.linked_alert_policy_id}


@router.post("/escalation-policies", status_code=status.HTTP_201_CREATED)
async def create_policy(request: Request,
                        body: PolicyCreate,
                        tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name must not be empty")
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_create_policy(%s,%s,%s)",
                    (tenant, body.name, body.description))
                row = await cur.fetchone()
        except Exception as exc:
            if "g23.empty_name" in str(exc):
                raise HTTPException(status_code=422,
                                    detail="name must not be empty")
            raise
    return row[0] if row else {}


@router.delete("/escalation-policies/{policy_id}",
               status_code=status.HTTP_200_OK)
async def delete_policy(policy_id: str, request: Request,
                        tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_delete_policy(%s,%s)",
                    (tenant, policy_id))
                row = await cur.fetchone()
        except Exception as exc:
            if "g23.policy_not_found" in str(exc):
                raise HTTPException(status_code=404,
                                    detail="policy not found")
            raise
    return row[0] if row else {}


@router.get("/escalation-policies/{policy_id}")
async def get_policy(policy_id: str, request: Request,
                     tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT policy_id, name, description, created_at
              FROM alerting.escalation_policy
             WHERE policy_id = %s AND tenant_id = %s AND deleted_at IS NULL
            """, (policy_id, tenant))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="policy not found")
        cols = [d.name for d in cur.description]
        policy = _ser(dict(zip(cols, row)))

        cur = await conn.execute(
            """
            SELECT step_number, delay_minutes, channel_class,
                   destination_ref, payload_ref
              FROM alerting.escalation_step
             WHERE policy_id = %s AND tenant_id = %s
             ORDER BY step_number
            """, (policy_id, tenant))
        cols = [d.name for d in cur.description]
        steps = [dict(zip(cols, r)) for r in await cur.fetchall()]
    return {"policy": policy, "steps": steps}


# ─── Step management ──────────────────────────────────────────────────────────

class StepCreate(BaseModel):
    step_number: int
    delay_minutes: int
    channel_class: str = "whatsapp_business@1"
    destination_ref: str
    payload_ref: str = "alert_notification"


@router.post("/escalation-policies/{policy_id}/steps",
             status_code=status.HTTP_201_CREATED)
async def add_step(policy_id: str, request: Request,
                   body: StepCreate,
                   tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    if body.channel_class not in _CHANNELS:
        raise HTTPException(status_code=422,
                            detail=f"channel_class one of {_CHANNELS}")
    if body.delay_minutes <= 0:
        raise HTTPException(status_code=422,
                            detail="delay_minutes must be > 0")
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_add_step(%s,%s,%s,%s,%s,%s,%s)",
                    (tenant, policy_id, body.step_number,
                     body.delay_minutes, body.channel_class,
                     body.destination_ref, body.payload_ref))
                row = await cur.fetchone()
        except Exception as exc:
            msg = str(exc)
            if "g23.policy_not_found" in msg:
                raise HTTPException(status_code=404,
                                    detail="policy not found")
            if "g23.invalid_delay" in msg:
                raise HTTPException(status_code=422,
                                    detail="delay_minutes must be > 0")
            if "g23.invalid_channel" in msg:
                raise HTTPException(status_code=422,
                                    detail="unsupported channel_class")
            if "unique" in msg.lower():
                raise HTTPException(
                    status_code=409,
                    detail=f"step {body.step_number} already exists")
            raise
    return row[0] if row else {}


@router.delete("/escalation-policies/{policy_id}/steps/{step_number}",
               status_code=status.HTTP_200_OK)
async def delete_step(policy_id: str, step_number: int,
                      request: Request,
                      tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_delete_step(%s,%s,%s)",
                    (tenant, policy_id, step_number))
                row = await cur.fetchone()
        except Exception as exc:
            if "g23.step_not_found" in str(exc):
                raise HTTPException(status_code=404,
                                    detail="step not found")
            raise
    return row[0] if row else {}


# ─── Alert escalation arm/disarm ──────────────────────────────────────────────

class ArmBody(BaseModel):
    policy_id: str


@router.post("/alerts/{alert_id}/escalation-policy",
             status_code=status.HTTP_200_OK)
async def arm_alert(alert_id: str, request: Request,
                    body: ArmBody,
                    tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_arm_alert(%s,%s,%s)",
                    (tenant, alert_id, body.policy_id))
                row = await cur.fetchone()
        except Exception as exc:
            msg = str(exc)
            if "g23.alert_not_active" in msg:
                raise HTTPException(status_code=422,
                                    detail="alert is not active")
            if "g23.policy_not_found" in msg:
                raise HTTPException(status_code=404,
                                    detail="policy not found")
            raise
    return row[0] if row else {}


@router.delete("/alerts/{alert_id}/escalation-policy",
               status_code=status.HTTP_200_OK)
async def disarm_alert(alert_id: str, request: Request,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
                cur = await conn.execute(
                    "SELECT alerting.g23_disarm_alert(%s,%s)",
                    (tenant, alert_id))
                row = await cur.fetchone()
        except Exception as exc:
            if "g23.escalation_not_found" in str(exc):
                raise HTTPException(status_code=404,
                                    detail="no active escalation on this alert")
            raise
    return row[0] if row else {}


@router.get("/alerts/{alert_id}/escalation-policy")
async def get_alert_escalation(alert_id: str, request: Request,
                               tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT ae.escalation_id, ae.policy_id, ep.name,
                   ae.current_step, ae.armed_at, ae.last_fired_at,
                   ae.completed_at
              FROM alerting.alert_escalation ae
              JOIN alerting.escalation_policy ep
                ON ep.policy_id = ae.policy_id
               AND ep.tenant_id = ae.tenant_id
             WHERE ae.alert_id = %s AND ae.tenant_id = %s
            """, (alert_id, tenant))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="no escalation on this alert")
        cols = [d.name for d in cur.description]
    return _ser(dict(zip(cols, row)))
