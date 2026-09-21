/* JLMirror protected shell — minimal G1 surface.
 *
 * States: loading → unauthenticated | forbidden | needs_tenant | ready | unavailable
 * All authority comes from the BFF session endpoints; the shell only projects state.
 */

const root = document.getElementById("root");
const meta = document.getElementById("meta");
const err = document.getElementById("err");

function readCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function csrfHeaders() {
  const t = readCookie("jl_csrf");
  return t ? { "X-CSRF-Token": t, "Content-Type": "application/json" } : {};
}

function render(html) { root.innerHTML = html; }
/* Escape any server/provider-supplied value before it enters an
 * innerHTML template — monitoring data (problem summaries, display
 * names, refs) is attacker-influenceable upstream. */
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
            '"': "&quot;", "'": "&#39;" }[c]));
}
function fail(msg) {
  err.textContent = msg;
  err.classList.remove("hidden");
}

async function refresh() {
  err.classList.add("hidden");
  let r;
  try {
    r = await fetch("/api/session", { credentials: "same-origin" });
  } catch {
    render('<p style="color:#f08080">Service unavailable.</p>');
    return;
  }
  const s = await r.json();

  switch (s.state) {
    case "unauthenticated": {
      render('<a class="btn" href="/auth/login">Sign in</a>');
      meta.innerHTML = "";
      break;
    }
    case "forbidden": {
      render('<p style="color:#f08080">Access denied.</p>' +
             '<form method="post" action="/auth/logout" style="margin-top:1rem">' +
             '<button class="secondary" type="submit">Sign out</button></form>');
      meta.innerHTML = "";
      break;
    }
    case "needs_tenant": {
      const items = s.memberships.map(m =>
        `<div class="tenant"><span>${esc(m.display_name)}</span>` +
        `<button data-t="${esc(m.tenant_id)}" class="pick">Select</button></div>`).join("");
      render(`<p style="margin-bottom:.75rem">Select a tenant:</p>${items}`);
      document.querySelectorAll(".pick").forEach(b =>
        b.addEventListener("click", () => selectTenant(b.dataset.t)));
      meta.innerHTML = `<code>${esc(s.principal_id)}</code>`;
      break;
    }
    case "ready": {
      document.querySelector(".card").classList.add("wide");
      render(
        `<p>Signed in to <strong>${esc(s.tenant.display_name)}</strong></p>` +
        `<div class="meta" style="margin:1rem 0 1.25rem">` +
        `principal <code>${esc(s.principal_id)}</code> · role <code>${esc(s.tenant.role)}</code></div>` +
        `<div style="display:flex;gap:.5rem">` +
        `<button class="secondary" id="changeTenant">Change tenant</button>` +
        `<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>` +
        `</div>` +
        `<div class="section"><h2>Monitoring</h2><div id="mon">` +
        `<div class="spinner"></div></div></div>`);
      document.getElementById("changeTenant").addEventListener("click", async () => {
        render(`<p style="margin-bottom:.75rem">Select a tenant:</p>` +
          s.memberships.map(m =>
            `<div class="tenant"><span>${esc(m.display_name)}</span>` +
            `<button data-t="${esc(m.tenant_id)}" class="pick">Select</button></div>`).join(""));
        document.querySelectorAll(".pick").forEach(b =>
          b.addEventListener("click", () => selectTenant(b.dataset.t)));
      });
      meta.innerHTML = `authenticated at <code>${esc(s.authenticated_at)}</code>`;
      loadMonitoring(s);
      break;
    }
    default: {
      render('<p style="color:#f08080">Service unavailable.</p>');
    }
  }
}

async function selectTenant(tenantId) {
  const r = await fetch("/api/tenant/select", {
    method: "POST",
    credentials: "same-origin",
    headers: csrfHeaders(),
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  const s = await r.json();
  if (s.state !== "ready") {
    fail("Access denied.");
    return;
  }
  refresh();
}

// ---------------------------------------------------------------------------
// Monitoring view — read-only projections + dev poll triggers
// ---------------------------------------------------------------------------

function api(path) {
  return fetch(`/api/v1/monitoring${path}`, { credentials: "same-origin" })
    .then(r => r.json());
}

async function poll(sourceId, kind, tenantId) {
  await fetch(`/api/v1/monitoring/sources/${sourceId}/${kind}?tenant_id=${tenantId}`, {
    method: "POST", credentials: "same-origin", headers: csrfHeaders(),
  });
}

async function loadMonitoring(s) {
  const mon = document.getElementById("mon");
  const tid = s.tenant.tenant_id;
  let sources, alerts;
  try {
    [sources, alerts] = await Promise.all([
      api(`/sources?tenant_id=${tid}`),
      fetch(`/api/v1/alerting/alerts?tenant_id=${tid}`,
            { credentials: "same-origin" }).then(r => r.ok ? r.json() : []),
    ]);
  } catch {
    mon.innerHTML = '<p class="empty">Monitoring unavailable.</p>';
    return;
  }
  const listHtml = (!Array.isArray(sources) || sources.length === 0)
    ? '<p class="empty">No monitoring sources configured.</p>'
    : `<table><thead><tr><th>Source</th><th>Provider</th>` +
      `<th>Evidence</th></tr></thead><tbody>` +
      sources.map(src =>
        `<tr class="clickable" data-src="${esc(src.monitoring_source_id)}">` +
        `<td>${esc(src.display_name)}</td>` +
        `<td><code>${esc(src.provider_instance_ref)}</code></td>` +
        `<td>${esc(src.operational_evidence_state)}</td></tr>`).join("") +
      `</tbody></table>`;

  const alertsHtml = (!Array.isArray(alerts) || alerts.length === 0)
    ? '<p class="empty">No alerts.</p>'
    : `<table><thead><tr><th>State</th><th>Alert</th>` +
      `<th>Policy</th><th>Source kind</th><th>Opened</th></tr></thead><tbody>` +
      alerts.map(a =>
        `<tr class="clickable" data-alert="${esc(a.alert_id)}">` +
        `<td class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</td>` +
        `<td><code>${esc((a.alert_id || "").slice(0, 18))}</code></td>` +
        `<td>${esc(a.policy_id)} v${esc(a.policy_version)}</td>` +
        `<td>${esc(a.source_kind)}</td>` +
        `<td>${esc((a.opened_at || "").slice(0, 19))}</td></tr>`).join("") +
      `</tbody></table>`;

  mon.innerHTML =
    `<div class="actions"><button class="secondary" id="addSource">` +
    `+ add source</button></div>` + listHtml +
    `<div class="section"><h2>Alerts</h2>${alertsHtml}</div>` +
    `<div id="monDetail"></div>`;

  document.getElementById("addSource").addEventListener(
    "click", () => renderOnboardForm(tid));

  mon.querySelectorAll("[data-src]").forEach(row =>
    row.addEventListener("click", () =>
      loadSourceDetail(row.dataset.src, tid)));
  mon.querySelectorAll("[data-alert]").forEach(row =>
    row.addEventListener("click", () =>
      loadAlertDetail(row.dataset.alert, tid)));
}

// ---------------------------------------------------------------------------
// Source onboarding — the user-facing provider configuration path.
// provider_base_url + credential binding ref + host-group refs are
// user inputs, exactly as the API contract requires; the credential
// VALUE itself resolves through the credential binding (dev: env).
// ---------------------------------------------------------------------------

function renderOnboardForm(tid) {
  const det = document.getElementById("monDetail");
  det.innerHTML =
    `<div class="section"><h2>Add Zabbix source</h2>` +
    `<form id="onboardForm">` +
    `<label>Display name<input name="display_name" required` +
    ` placeholder="prod-zabbix"></label>` +
    `<label>Provider instance ref<input name="provider_instance_ref" required` +
    ` placeholder="zabbix-prod-1"></label>` +
    `<label>Base URL<input name="provider_base_url" required` +
    ` placeholder="https://zabbix.example.com" pattern="https://.*"></label>` +
    `<label>Credential binding ref<input name="credential_binding_ref"` +
    ` required placeholder="cred-binding-1"></label>` +
    `<label>Host group refs<input name="host_group_refs" required` +
    ` placeholder="5,6 (comma-separated groupids)"></label>` +
    `<button type="submit">Create source</button>` +
    `<div class="error hidden" id="onboardErr"></div></form></div>`;

  document.getElementById("onboardForm").addEventListener(
    "submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const body = {
        tenant_id: tid,
        display_name: f.display_name.value.trim(),
        provider_instance_ref: f.provider_instance_ref.value.trim(),
        provider_base_url: f.provider_base_url.value.trim(),
        credential_binding_ref: f.credential_binding_ref.value.trim(),
        host_group_refs: f.host_group_refs.value.split(",")
          .map(s => s.trim()).filter(Boolean),
      };
      const r = await fetch("/api/v1/monitoring/sources", {
        method: "POST", credentials: "same-origin",
        headers: csrfHeaders(), body: JSON.stringify(body),
      });
      const resp = await r.json();
      if (r.status !== 201) {
        const e = document.getElementById("onboardErr");
        e.textContent = resp.detail
          ? (typeof resp.detail === "string" ? resp.detail
             : JSON.stringify(resp.detail))
          : "Create failed";
        e.classList.remove("hidden");
        return;
      }
      refresh();  // validation op enqueued automatically with the source
    });
}

async function loadSourceDetail(sourceId, tid) {
  const det = document.getElementById("monDetail");
  det.innerHTML = '<div class="spinner"></div>';
  const [health, problems, current, ops, alerts] = await Promise.all([
    api(`/sources/${sourceId}/health?tenant_id=${tid}`),
    api(`/sources/${sourceId}/problems?tenant_id=${tid}&active_only=true`),
    api(`/sources/${sourceId}/current?tenant_id=${tid}`),
    api(`/sources/${sourceId}/operations?tenant_id=${tid}`),
    fetch(`/api/v1/alerting/alerts?tenant_id=${tid}&source_id=${sourceId}`,
          { credentials: "same-origin" })
        .then(r => r.ok ? r.json() : []),
  ]);

  const healthRows = Array.isArray(health) && health.length
    ? health.map(h =>
        `<tr><td><code>${esc(h.monitoring_resource_id)}</code></td>` +
        `<td class="h-${esc(h.health_class)}">${esc(h.health_class)}</td>` +
        `<td>${esc(h.evidence_state)}</td>` +
        `<td>r${esc(h.projection_revision)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No health projections yet</td></tr>`;

  const problemRows = Array.isArray(problems) && problems.length
    ? problems.map(p =>
        `<tr><td class="sev-${esc(p.severity_class)}">${esc(p.severity_class)}</td>` +
        `<td>${esc(p.summary)}</td>` +
        `<td><code>${esc(p.provider_eventid)}</code></td>` +
        `<td>${esc(p.evidence_state)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No active problems</td></tr>`;

  const currentRows = Array.isArray(current) && current.length
    ? current.slice(0, 20).map(c =>
        `<tr><td>${esc(c.name || c.metric_definition_id)}</td>` +
        `<td><code>${esc(c.canonical_value)}</code></td>` +
        `<td>${esc(c.evidence_state)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">No current state</td></tr>`;

  const alertRows = Array.isArray(alerts) && alerts.length
    ? alerts.map(a =>
        `<tr class="clickable" data-alert="${esc(a.alert_id)}">` +
        `<td class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</td>` +
        `<td><code>${esc((a.alert_id || "").slice(0, 18))}</code></td>` +
        `<td>${esc(a.source_kind)}</td>` +
        `<td>${esc(a.policy_id)} v${esc(a.policy_version)}</td>` +
        `<td>r${esc(a.source_occurrence_revision)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No alerts</td></tr>`;

  const badStates = new Set(["reconciliation_required", "failed_terminal"]);
  const opRows = Array.isArray(ops) && ops.length
    ? ops.map(o =>
        `<tr class="${badStates.has(o.state) ? "op-bad" : ""}">` +
        `<td class="op-${esc(o.state)}">${esc(o.state)}</td>` +
        `<td>${esc(o.responsibility_kind)}</td>` +
        `<td><code>${esc((o.monitoring_sync_operation_id || "").slice(0, 20))}</code></td>` +
        `<td>${esc(o.last_error_class)}</td>` +
        `<td>${esc(o.created_at)}</td>` +
        `<td>${badStates.has(o.state)
            ? `<button class="secondary op-requeue" data-op="${esc(o.monitoring_sync_operation_id)}">retry</button>`
            : ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">No operations</td></tr>`;

  det.innerHTML =
    `<div class="actions">` +
    `<button class="secondary" data-p="inventory">inventory</button>` +
    `<button class="secondary" data-p="metrics/poll">metrics</button>` +
    `<button class="secondary" data-p="current/poll">current</button>` +
    `<button class="secondary" data-p="history/poll">history</button>` +
    `<button class="secondary" data-p="problems/poll">problems</button>` +
    `<button class="secondary" id="monRefresh">refresh</button></div>` +
    `<div class="section"><h2>Health</h2>` +
    `<table><thead><tr><th>Resource</th><th>Health</th><th>Evidence</th>` +
    `<th>Rev</th></tr></thead><tbody>${healthRows}</tbody></table></div>` +
    `<div class="section"><h2>Active problems</h2>` +
    `<table><thead><tr><th>Severity</th><th>Summary</th><th>Event</th>` +
    `<th>Evidence</th></tr></thead><tbody>${problemRows}</tbody></table></div>` +
    `<div class="section"><h2>Current metrics</h2>` +
    `<table><thead><tr><th>Metric</th><th>Value</th><th>Evidence</th>` +
    `</tr></thead><tbody>${currentRows}</tbody></table></div>` +
    `<div class="section"><h2>Alerts</h2>` +
    `<table><thead><tr><th>State</th><th>Alert</th><th>Source kind</th>` +
    `<th>Policy</th><th>Rev</th></tr></thead>` +
    `<tbody>${alertRows}</tbody></table></div>` +
    `<div class="section"><h2>Operations (DLQ)</h2>` +
    `<table><thead><tr><th>State</th><th>Kind</th><th>Op</th>` +
    `<th>Error class</th><th>Created</th><th></th></tr></thead>` +
    `<tbody>${opRows}</tbody></table></div>`;

  det.querySelectorAll("[data-p]").forEach(b =>
    b.addEventListener("click", async () => {
      await poll(sourceId, b.dataset.p, tid);
      b.disabled = true; b.textContent = "queued";
    }));
  det.querySelectorAll(".op-requeue").forEach(b =>
    b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "queued";
      const r = await fetch(
        `/api/v1/monitoring/sources/${sourceId}/operations/` +
        `${b.dataset.op}/requeue?tenant_id=${tid}`,
        { method: "POST", credentials: "same-origin",
          headers: csrfHeaders() });
      if (!r.ok) { b.textContent = "failed"; b.disabled = false; }
      else { await loadSourceDetail(sourceId, tid); }
    }));
  det.querySelectorAll("[data-alert]").forEach(row =>
    row.addEventListener("click", () =>
      loadAlertDetail(row.dataset.alert, tid)));
  document.getElementById("monRefresh").addEventListener("click", () =>
    loadSourceDetail(sourceId, tid));
}

// ---------------------------------------------------------------------------
// Alert detail — G7 occurrence + G8 human operations + G9 delivery.
// The UI MUST keep these distinct: alert lifecycle is not ACK, ACK is
// not the current action owner, and notification delivery (sent /
// provider accepted / delivered / external read) is never the G8
// authoritative native view.
// ---------------------------------------------------------------------------

function alerting(path, tid) {
  return fetch(`/api/v1/alerting${path}${path.includes("?") ? "&" : "?"}` +
               `tenant_id=${tid}`, { credentials: "same-origin" })
    .then(r => r.ok ? r.json() : null);
}

function post(path, tid, body) {
  return fetch(`/api/v1/alerting${path}?tenant_id=${tid}`, {
    method: "POST", credentials: "same-origin",
    headers: csrfHeaders(), body: JSON.stringify(body || {}),
  });
}

async function loadAlertDetail(alertId, tid) {
  const det = document.getElementById("monDetail");
  det.innerHTML = '<div class="spinner"></div>';
  const [detail, timeline, notifications] = await Promise.all([
    alerting(`/alerts/${alertId}`, tid),
    alerting(`/alerts/${alertId}/timeline`, tid),
    alerting(`/notifications`, tid),
  ]);
  if (!detail) {
    det.innerHTML = '<p class="empty">Alert unavailable.</p>';
    return;
  }
  const a = detail.alert;
  const transitions = (detail.transitions || []).map(t =>
    `<li><span class="t-kind">${esc(t.to_lifecycle_state)}</span> ` +
    `at r${esc(t.source_revision)} ` +
    `<span class="t-at">${esc((t.occurred_at || "").slice(0, 19))}</span></li>`
  ).join("");

  const cur = (timeline && timeline.current_action) || null;
  const curHtml = cur
    ? `<p>current action <strong>${esc(cur.action)}</strong>` +
      (cur.owner ? ` · owner <code>${esc(cur.owner)}</code>` : "") +
      ` · rev ${esc(cur.revision)}</p>`
    : `<p class="empty">no human action required</p>`;

  const events = ((timeline && timeline.timeline) || []).map(e =>
    `<li><span class="t-kind">${esc(e.kind)}</span> ` +
    `${esc(e.owner || e.principal_id || e.viewer || "")}` +
    `${e.action ? " · " + esc(e.action) : ""}` +
    `${e.note ? " · " + esc(e.note) : ""}` +
    `${e.reason ? " · " + esc(e.reason) : ""} ` +
    `<span class="t-at">${esc((e.at || "").slice(0, 19))}</span></li>`
  ).join("") || '<li class="empty">no human operations yet</li>';

  // Delivery is per-intent and scoped to THIS alert only.
  const mine = (notifications || []).filter(n => n.alert_id === alertId);
  const notifRows = mine.length
    ? mine.map(n =>
        `<tr><td class="d-${esc(n.current_state || "dispatching")}">` +
        `${esc(n.current_state || "dispatching")}</td>` +
        `<td>${esc(n.reason)}</td>` +
        `<td><code>${esc(n.destination_ref)}</code></td>` +
        `<td>${esc(n.attempt_count || 0)}` +
        `${n.retry_required ? '<span class="flag">retry</span>' : ""}` +
        `${n.fallback_action_required
            ? '<span class="flag bad">fallback required</span>' : ""}</td>` +
        `</tr>`).join("")
    : `<tr><td colspan="4" class="empty">No notifications</td></tr>`;

  det.innerHTML =
    `<div class="section"><h2>Alert ${esc(alertId.slice(0, 18))}</h2>` +
    `<p class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</p>` +
    `<div class="meta">policy <code>${esc(a.policy_id)}</code> ` +
    `v${esc(a.policy_version)} (pinned) · subject ` +
    `<code>${esc((a.source_subject_id || "").slice(0, 28))}</code> · ` +
    `occurrence r${esc(a.source_occurrence_revision)} · ` +
    `current r${esc(a.current_source_revision)}</div>` +
    `<ul class="timeline">${transitions}</ul></div>` +

    `<div class="section"><h2>Human operations</h2>${curHtml}` +
    `<ul class="timeline">${events}</ul>` +
    `<div class="actions">` +
    `<button class="secondary" id="btnAck">acknowledge</button>` +
    `<button class="secondary" id="btnAssign">assign action</button>` +
    `<button class="secondary" id="btnVis">require native view</button>` +
    `</div>` +
    `<p class="note">ACK is evidence only — it never changes alert ` +
    `lifecycle or action ownership.</p>` +
    `<div id="opsForm"></div></div>` +

    `<div class="section"><h2>Notification delivery</h2>` +
    `<table><thead><tr><th>Delivery</th><th>Reason</th>` +
    `<th>Destination</th><th>Attempts</th></tr></thead>` +
    `<tbody>${notifRows}</tbody></table>` +
    `<div class="actions">` +
    `<button class="secondary" id="btnNotify">notify via WhatsApp</button>` +
    `<button class="secondary" id="btnAlertRefresh">refresh</button></div>` +
    `<p class="note">provider accepted ≠ delivered ≠ read. External read ` +
    `evidence is supplementary — it is not the authoritative native view.` +
    `</p><div id="notifyForm"></div></div>`;

  const reload = () => loadAlertDetail(alertId, tid);
  document.getElementById("btnAlertRefresh")
    .addEventListener("click", reload);

  document.getElementById("btnAck").addEventListener("click", async () => {
    const note = prompt("ACK note (optional)") || null;
    const r = await post(`/alerts/${alertId}/ack`, tid, { note });
    if (!r.ok) fail("Acknowledge denied."); else reload();
  });

  document.getElementById("btnAssign").addEventListener("click", () => {
    document.getElementById("opsForm").innerHTML =
      `<form id="assignForm">` +
      `<label>Owner principal<input name="owner" required ` +
      `placeholder="principal.…"></label>` +
      `<label>Action<select name="kind">` +
      `<option>investigate_alert</option>` +
      `<option>acknowledge_alert</option>` +
      `<option>review_alert</option>` +
      `<option>customer_review_required</option></select></label>` +
      `<button type="submit">Assign</button></form>`;
    document.getElementById("assignForm").addEventListener(
      "submit", async (ev) => {
        ev.preventDefault();
        const r = await post(`/alerts/${alertId}/assign`, tid, {
          owner_principal_id: ev.target.owner.value.trim(),
          action_kind: ev.target.kind.value,
        });
        if (!r.ok) fail("Assign denied."); else reload();
      });
  });

  document.getElementById("btnVis").addEventListener("click", () => {
    document.getElementById("opsForm").innerHTML =
      `<form id="visForm">` +
      `<label>Required viewer principal<input name="viewer" required ` +
      `placeholder="principal.…"></label>` +
      `<label>Side<select name="side">` +
      `<option>internal</option><option>customer</option></select></label>` +
      `<button type="submit">Require native view</button></form>` +
      `<p class="note">Only platform_native_authenticated_view@1 is ` +
      `admitted, and only while the alert is active.</p>`;
    document.getElementById("visForm").addEventListener(
      "submit", async (ev) => {
        ev.preventDefault();
        const r = await post(
          `/alerts/${alertId}/visibility-requirements`, tid, {
            required_viewer_principal_id: ev.target.viewer.value.trim(),
            viewer_side: ev.target.side.value,
          });
        if (!r.ok) fail("Requirement denied (alert must be active).");
        else reload();
      });
  });

  document.getElementById("btnNotify").addEventListener("click", () => {
    document.getElementById("notifyForm").innerHTML =
      `<form id="notifyFormEl">` +
      `<label>Destination reference<input name="dest" required ` +
      `placeholder="5511999990000"></label>` +
      `<label>Reason<select name="reason">` +
      `<option>alert_requires_attention</option>` +
      `<option>alert_action_requested</option>` +
      `<option>customer_awareness_required</option></select></label>` +
      `<button type="submit">Create intent</button></form>` +
      `<p class="note">Creating an intent never changes alert, ACK or ` +
      `ownership state. Dispatch is worker-owned and retried bounded.</p>`;
    document.getElementById("notifyFormEl").addEventListener(
      "submit", async (ev) => {
        ev.preventDefault();
        const r = await post(`/alerts/${alertId}/notifications`, tid, {
          destination_ref: ev.target.dest.value.trim(),
          reason: ev.target.reason.value,
        });
        if (!r.ok) fail("Notification denied."); else reload();
      });
  });
}

// Surface auth errors from the callback redirect (e.g. /?error=forbidden)
const params = new URLSearchParams(location.search);
if (params.get("error") === "forbidden") fail("Access denied.");
if (params.get("error") === "auth_failed") fail("Authentication failed. Try again.");

refresh();
