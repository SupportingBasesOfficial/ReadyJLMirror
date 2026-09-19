"""G7 alert policy evaluation (contract: canonical
implementation/g7-alert-policy-lifecycle/DESIGN.md).

Runs after problem_state / health projection completion:
  accepted resync -> reread current Monitoring owner state
  -> evaluate current effective enabled policy versions
  -> create or resolve one Alert occurrence
  -> idempotent by (subject, source_revision, effect, policy)

Currentness law: non-current source evidence or non-current
projection evidence produces no lifecycle effect. An alert pinned
to a superseded version may only resolve its own occurrence.
"""

from __future__ import annotations

import hashlib
import json
import secrets

SEVERITY_ORDER = {
    "unknown": 0, "informational": 1, "warning": 2,
    "degraded": 3, "critical": 4,
}


def _decision_hash(tenant_id: str, policy_id: str,
                   policy_version: int, subject: str,
                   revision: int, effect: str) -> str:
    payload = f"{tenant_id}|{policy_id}|{policy_version}|" \
              f"{subject}|{revision}|{effect}"
    return hashlib.sha256(payload.encode()).hexdigest()


def _content_hash(version: dict) -> str:
    canonical = json.dumps({
        "source_kind": version["source_kind"],
        "problem_min_severity": version["problem_min_severity"],
        "health_classes": sorted(version["health_classes"]),
        "monitoring_source_id": version["monitoring_source_id"],
        "monitoring_resource_id": version["monitoring_resource_id"],
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def evaluate_problem_policies(conn, *, tenant_id: str,
                              monitoring_source_id: str) -> dict:
    """Reread current problems for the source and apply lifecycle.

    Returns {'created': n, 'resolved': n, 'skipped': n}."""
    # Currentness gate: source evidence must be current and the
    # generation must be the source's active generation.
    cur = conn.execute(
        """
        SELECT s.active_source_instance_generation,
               s.operational_evidence_state
          FROM monitoring.monitoring_source s
         WHERE s.tenant_id = %s AND s.monitoring_source_id = %s
        """, (tenant_id, monitoring_source_id))
    row = cur.fetchone()
    if row is None or row[1] != "current":
        return {"created": 0, "resolved": 0, "skipped": 0,
                "reason": "source_not_current"}
    active_generation = row[0]

    # Current problems only: active state, current evidence,
    # active source generation.
    cur = conn.execute(
        """
        SELECT problem_id, monitoring_resource_id, severity_class,
               projection_revision
          FROM monitoring.monitoring_problem
         WHERE tenant_id = %s AND monitoring_source_id = %s
           AND problem_state = 'active'
           AND evidence_state = 'current'
           AND source_instance_generation = %s
        """, (tenant_id, monitoring_source_id, active_generation))
    problems = cur.fetchall()
    problems_by_id = {p[0]: p for p in problems}

    # Current effective ENABLED problem policies for this tenant.
    cur = conn.execute(
        """
        SELECT pv.policy_id, pv.policy_version,
               pv.problem_min_severity, pv.monitoring_source_id,
               pv.monitoring_resource_id, pv.content_hash
          FROM alerting.alert_policy_version pv
          JOIN alerting.alert_policy_effective_version ev
            ON ev.tenant_id = pv.tenant_id
           AND ev.policy_id = pv.policy_id
           AND ev.policy_version = pv.policy_version
           AND ev.enabled = TRUE
         WHERE pv.tenant_id = %s
           AND pv.source_kind = 'monitoring_problem'
           AND pv.superseded_at IS NULL
        """, (tenant_id,))
    policies = cur.fetchall()

    stats = {"created": 0, "resolved": 0, "skipped": 0}
    for (policy_id, version, min_sev, sel_source, sel_resource,
         content_hash) in policies:
        # Selector scope: policy may pin a source/resource.
        if sel_source and sel_source != monitoring_source_id:
            continue
        min_rank = SEVERITY_ORDER[min_sev]

        # Active alerts pinned to this policy (any version) for
        # subjects owned by this source.
        cur = conn.execute(
            """
            SELECT alert_id, policy_version, source_subject_id
              FROM alerting.alert
             WHERE tenant_id = %s AND policy_id = %s
               AND source_kind = 'monitoring_problem'
               AND monitoring_source_id = %s
               AND lifecycle_state = 'active'
            """, (tenant_id, policy_id, monitoring_source_id))
        open_alerts = {r[2]: (r[0], r[1]) for r in cur.fetchall()}

        # Evaluate each current problem: does it match this policy?
        for pid, (problem_id, resource_id, severity,
                  revision) in problems_by_id.items():
            matches = (SEVERITY_ORDER.get(severity, -1) >= min_rank
                       and (not sel_resource
                            or sel_resource == resource_id))
            existing = open_alerts.get(problem_id)
            decision_hash = _decision_hash(
                tenant_id, policy_id, version, problem_id,
                revision, "create")

            if matches and existing is None:
                # Idempotent create — replay returns recorded effect.
                cur = conn.execute(
                    """
                    SELECT alert_id FROM alerting.alert_decision
                     WHERE tenant_id=%s AND policy_id=%s
                       AND source_kind='monitoring_problem'
                       AND source_subject_id=%s
                       AND source_revision=%s
                       AND effect_kind='create'
                    """, (tenant_id, policy_id, problem_id,
                          revision))
                prior = cur.fetchone()
                if prior:
                    stats["skipped"] += 1
                    continue
                alert_id = f"alert_{secrets.token_urlsafe(12)}"
                summary = json.dumps({
                    "problem_id": problem_id,
                    "severity_class": severity,
                    "projection_revision": revision})
                conn.execute(
                    """
                    INSERT INTO alerting.alert
                        (tenant_id, alert_id, policy_id,
                         policy_version, source_kind,
                         source_subject_id, monitoring_source_id,
                         monitoring_resource_id,
                         source_instance_generation,
                         source_occurrence_revision,
                         current_source_revision, lifecycle_state,
                         source_evidence_summary)
                    VALUES (%s,%s,%s,%s,'monitoring_problem',
                            %s,%s,%s,%s,%s,%s,'active',%s::jsonb)
                    """,
                    (tenant_id, alert_id, policy_id, version,
                     problem_id, monitoring_source_id, resource_id,
                     active_generation, revision, revision, summary))
                conn.execute(
                    """
                    INSERT INTO alerting.alert_transition
                        (tenant_id, alert_transition_id, alert_id,
                         policy_id, policy_version,
                         from_lifecycle_state, to_lifecycle_state,
                         source_revision, source_evidence_summary)
                    VALUES (%s,%s,%s,%s,%s,NULL,'active',%s,%s::jsonb)
                    """,
                    (tenant_id, f"tr_{secrets.token_urlsafe(12)}",
                     alert_id, policy_id, version, revision, summary))
                conn.execute(
                    """
                    INSERT INTO alerting.alert_decision
                        (tenant_id, decision_id, decision_hash,
                         policy_id, policy_version, source_kind,
                         source_subject_id, source_revision,
                         effect_kind, alert_id)
                    VALUES (%s,%s,%s,%s,%s,'monitoring_problem',
                            %s,%s,'create',%s)
                    """,
                    (tenant_id, f"dec_{secrets.token_urlsafe(12)}",
                     decision_hash, policy_id, version, problem_id,
                     revision, alert_id))
                stats["created"] += 1
            elif not matches and existing is not None:
                alert_id, pinned_version = existing
                # Pinned-version continuation: only resolve an
                # occurrence the pinned version already opened, and
                # only after a current reread proves no match.
                cur = conn.execute(
                    """
                    SELECT alert_id FROM alerting.alert_decision
                     WHERE tenant_id=%s AND policy_id=%s
                       AND source_kind='monitoring_problem'
                       AND source_subject_id=%s
                       AND source_revision=%s
                       AND effect_kind='resolve'
                    """, (tenant_id, policy_id, problem_id,
                          revision))
                if cur.fetchone():
                    stats["skipped"] += 1
                    continue
                summary = json.dumps({
                    "problem_id": problem_id,
                    "severity_class": severity,
                    "projection_revision": revision,
                    "reason": "condition_no_longer_matches"})
                conn.execute(
                    """
                    UPDATE alerting.alert
                       SET lifecycle_state='resolved',
                           resolved_at=transaction_timestamp(),
                           current_source_revision=%s,
                           updated_at=transaction_timestamp()
                     WHERE tenant_id=%s AND alert_id=%s
                    """, (revision, tenant_id, alert_id))
                conn.execute(
                    """
                    INSERT INTO alerting.alert_transition
                        (tenant_id, alert_transition_id, alert_id,
                         policy_id, policy_version,
                         from_lifecycle_state, to_lifecycle_state,
                         source_revision, source_evidence_summary)
                    VALUES (%s,%s,%s,%s,%s,'active','resolved',
                            %s,%s::jsonb)
                    """,
                    (tenant_id, f"tr_{secrets.token_urlsafe(12)}",
                     alert_id, policy_id, pinned_version, revision,
                     summary))
                conn.execute(
                    """
                    INSERT INTO alerting.alert_decision
                        (tenant_id, decision_id, decision_hash,
                         policy_id, policy_version, source_kind,
                         source_subject_id, source_revision,
                         effect_kind, alert_id)
                    VALUES (%s,%s,%s,%s,%s,'monitoring_problem',
                            %s,%s,'resolve',%s)
                    """,
                    (tenant_id, f"dec_{secrets.token_urlsafe(12)}",
                     _decision_hash(tenant_id, policy_id,
                                    pinned_version, problem_id,
                                    revision, "resolve"),
                     policy_id, pinned_version, problem_id,
                     revision, alert_id))
                stats["resolved"] += 1

        # Resolve alerts whose problem disappeared from the
        # current active set (resolved at source or evidence aged).
        for subject, (alert_id, pinned_version) in open_alerts.items():
            if subject in problems_by_id:
                continue
            cur = conn.execute(
                """
                SELECT COALESCE(MAX(projection_revision), 0)
                  FROM monitoring.monitoring_problem
                 WHERE tenant_id=%s AND problem_id=%s
                """, (tenant_id, subject))
            revision = cur.fetchone()[0] or 1
            cur = conn.execute(
                """
                SELECT alert_id FROM alerting.alert_decision
                 WHERE tenant_id=%s AND policy_id=%s
                   AND source_subject_id=%s AND effect_kind='resolve'
                   AND source_revision=%s
                """, (tenant_id, policy_id, subject, revision))
            if cur.fetchone():
                continue
            summary = json.dumps({
                "problem_id": subject,
                "reason": "problem_no_longer_active_current"})
            conn.execute(
                """
                UPDATE alerting.alert
                   SET lifecycle_state='resolved',
                       resolved_at=transaction_timestamp(),
                       current_source_revision=%s,
                       updated_at=transaction_timestamp()
                 WHERE tenant_id=%s AND alert_id=%s
                """, (revision, tenant_id, alert_id))
            conn.execute(
                """
                INSERT INTO alerting.alert_transition
                    (tenant_id, alert_transition_id, alert_id,
                     policy_id, policy_version,
                     from_lifecycle_state, to_lifecycle_state,
                     source_revision, source_evidence_summary)
                VALUES (%s,%s,%s,%s,%s,'active','resolved',%s,
                        %s::jsonb)
                """,
                (tenant_id, f"tr_{secrets.token_urlsafe(12)}",
                 alert_id, policy_id, pinned_version, revision,
                 summary))
            conn.execute(
                """
                INSERT INTO alerting.alert_decision
                    (tenant_id, decision_id, decision_hash,
                     policy_id, policy_version, source_kind,
                     source_subject_id, source_revision,
                     effect_kind, alert_id)
                VALUES (%s,%s,%s,%s,%s,'monitoring_problem',
                        %s,%s,'resolve',%s)
                """,
                (tenant_id, f"dec_{secrets.token_urlsafe(12)}",
                 _decision_hash(tenant_id, policy_id, pinned_version,
                                subject, revision, "resolve"),
                 policy_id, pinned_version, subject, revision,
                 alert_id))
            stats["resolved"] += 1
    return stats
