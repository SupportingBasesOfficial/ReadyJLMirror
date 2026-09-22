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

// Server timestamps are always UTC ISO; render in the viewer's own
// timezone (the browser knows it) — correct for any user anywhere.
function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : esc(d.toLocaleString());
}
function fail(msg) {
  err.textContent = msg;
  err.classList.remove("hidden");
}

let sessionState = null;
let currentView = "alerts";
let alertFilter = "active";
let lastAlerts = [];

function renderCenter(html) {
  render(`<div class="centerwrap"><div class="card">${html}</div></div>`);
}

function showView(v) {
  if (!sessionState) return;
  currentView = v;
  document.querySelectorAll(".navbtn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === v));
  if (v === "monitoring") loadMonitoring(sessionState);
  else if (v === "admin") loadAdmin(sessionState);
  else loadAlerts(sessionState);
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
  document.getElementById("topbar").classList.add("hidden");
  document.getElementById("sidenav").classList.add("hidden");
  sessionState = null;

  switch (s.state) {
    case "unauthenticated": {
      renderCenter(
        `<h1><span class="brand">JL</span>Mirror</h1>` +
        `<div class="sub">Enterprise operations platform</div>` +
        `<a class="btn" href="/auth/login">Sign in</a>` +
        (s.environment === "development"
          ? `<div style="margin-top:1rem"><a class="link" ` +
            `style="font-size:.78rem" href="/auth/dev-login">` +
            `dev sign-in</a></div>`
          : ""));
      meta.innerHTML = "";
      break;
    }
    case "forbidden": {
      renderCenter('<p style="color:#f08080">Access denied.</p>' +
             '<form method="post" action="/auth/logout" style="margin-top:1rem">' +
             '<button class="secondary" type="submit">Sign out</button></form>');
      meta.innerHTML = "";
      break;
    }
    case "needs_tenant": {
      const items = s.memberships.map(m =>
        `<div class="tenant"><span>${esc(m.display_name)}</span>` +
        `<button data-t="${esc(m.tenant_id)}" class="pick">Select</button></div>`).join("");
      renderCenter(`<h1><span class="brand">JL</span>Mirror</h1>` +
        `<p style="margin:.75rem 0">Select a tenant:</p>${items}`);
      document.querySelectorAll(".pick").forEach(b =>
        b.addEventListener("click", () => selectTenant(b.dataset.t)));
      meta.innerHTML = `<code>${esc(s.principal_id)}</code>`;
      break;
    }
    case "ready": {
      sessionState = s;
      document.getElementById("topbar").classList.remove("hidden");
      document.getElementById("sidenav").classList.remove("hidden");
      document.getElementById("topTenant").textContent =
        s.tenant.display_name;
      document.getElementById("topWho").textContent =
        `${s.principal_id} · ${s.tenant.role}`;
      document.getElementById("changeTenant").onclick = () => {
        render(`<p style="margin-bottom:.75rem">Select a tenant:</p>` +
          s.memberships.map(m =>
            `<div class="tenant"><span>${esc(m.display_name)}</span>` +
            `<button data-t="${esc(m.tenant_id)}" class="pick">Select</button></div>`).join(""));
        document.querySelectorAll(".pick").forEach(b =>
          b.addEventListener("click", () => selectTenant(b.dataset.t)));
      };
      meta.innerHTML = `authenticated at <code>${fmtTs(s.authenticated_at)}</code>`;
      showView(currentView);
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
  const tid = s.tenant.tenant_id;
  render(
    `<div class="viewhead"><h2>Monitoring sources</h2>` +
    `<span class="spacer"></span>` +
    `<button class="secondary small" id="addSource">+ add source</button>` +
    `</div><div id="monBody"><div class="spinner"></div></div>`);
  document.getElementById("addSource").addEventListener(
    "click", () => renderOnboardForm(tid));
  const mon = document.getElementById("monBody");
  let sources;
  try {
    sources = await api(`/sources?tenant_id=${tid}`);
  } catch {
    mon.innerHTML = '<p class="empty">Monitoring unavailable.</p>';
    return;
  }
  mon.innerHTML = (!Array.isArray(sources) || sources.length === 0)
    ? '<p class="empty">No monitoring sources configured.</p>'
    : `<table><thead><tr><th>Source</th><th>Provider</th>` +
      `<th>Evidence</th></tr></thead><tbody>` +
      sources.map(src =>
        `<tr class="clickable" data-src="${esc(src.monitoring_source_id)}">` +
        `<td>${esc(src.display_name)}</td>` +
        `<td><code>${esc(src.provider_instance_ref)}</code></td>` +
        `<td>${esc(src.operational_evidence_state)}</td></tr>`).join("") +
      `</tbody></table>`;
  mon.querySelectorAll("[data-src]").forEach(row =>
    row.addEventListener("click", () =>
      loadSourceDetail(row.dataset.src, tid)));
}

// ---------------------------------------------------------------------------
// Alerts view — the operational landing page. Active first.
// ---------------------------------------------------------------------------

async function loadAlerts(s) {
  const tid = s.tenant.tenant_id;
  render(
    `<div class="viewhead"><h2>Alerts</h2><span class="spacer"></span>` +
    `<button class="chip" data-f="active">active</button>` +
    `<button class="chip" data-f="resolved">resolved</button>` +
    `<button class="chip" data-f="all">all</button></div>` +
    `<div id="alertBody"><div class="spinner"></div></div>`);
  document.querySelectorAll("[data-f]").forEach(b =>
    b.addEventListener("click", () => {
      alertFilter = b.dataset.f;
      renderAlertList(tid);
    }));
  let alerts;
  try {
    const r = await fetch(`/api/v1/alerting/alerts?tenant_id=${tid}`,
                          { credentials: "same-origin" });
    alerts = r.ok ? await r.json() : [];
  } catch { alerts = []; }
  lastAlerts = Array.isArray(alerts) ? alerts : [];
  renderAlertList(tid);
}

function renderAlertList(tid) {
  document.querySelectorAll("[data-f]").forEach(b =>
    b.classList.toggle("active", b.dataset.f === alertFilter));
  const rows = lastAlerts
    .filter(a => alertFilter === "all" || a.lifecycle_state === alertFilter)
    .sort((a, b) => (a.lifecycle_state === "active" ? 0 : 1) -
                    (b.lifecycle_state === "active" ? 0 : 1) ||
                    (b.opened_at || "").localeCompare(a.opened_at || ""));
  document.getElementById("alertBody").innerHTML = rows.length === 0
    ? `<p class="empty">No ${alertFilter} alerts.</p>`
    : `<table><thead><tr><th>State</th><th>Alert</th>` +
      `<th>Policy</th><th>Source kind</th><th>Opened</th></tr></thead>` +
      `<tbody>` + rows.map(a =>
        `<tr class="clickable" data-alert="${esc(a.alert_id)}">` +
        `<td class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</td>` +
        `<td><code>${esc((a.alert_id || "").slice(0, 18))}</code></td>` +
        `<td>${esc(a.policy_id)} v${esc(a.policy_version)}</td>` +
        `<td>${esc(a.source_kind)}</td>` +
        `<td>${fmtTs(a.opened_at)}</td></tr>`).join("") +
      `</tbody></table>`;
  document.querySelectorAll("[data-alert]").forEach(row =>
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
  const det = root;
  det.innerHTML =
    `<div class="viewhead"><button class="backbtn" id="backMon">` +
    `&#8592; monitoring</button><h2>Add Zabbix source</h2></div>` +
    `<div class="panel">` +
    `<form id="onboardForm">` +
    `<label>Display name<input name="display_name" required` +
    ` placeholder="prod-zabbix"></label>` +
    `<label>Provider instance ref<input name="provider_instance_ref" required` +
    ` placeholder="zabbix-prod-1"></label>` +
    `<label>Base URL<input name="provider_base_url" required` +
    ` placeholder="https://zabbix.example.com" pattern="https://.*"></label>` +
    `<label>Credential binding ref<input name="credential_binding_ref"` +
    ` required placeholder="cred-binding-1"></label>` +
    `<label>API token <span style="color:#8b93a5">(optional — ` +
    `written to the secrets store, never stored in the DB)</span>` +
    `<input name="api_token" type="password" autocomplete="off"` +
    ` placeholder="leave empty if the token file already exists"></label>` +
    `<label>Host group refs<input name="host_group_refs" required` +
    ` placeholder="5,6 (comma-separated groupids)"></label>` +
    `<button type="button" class="secondary small" id="discoverGroups">` +
    `discover groups</button>` +
    ` <span style="color:#8b93a5;font-size:12px">uses base URL + ` +
    `API token above to list the provider's groups</span>` +
    `<div id="groupList" style="margin:8px 0"></div>` +
    `<button type="submit">Create source</button>` +
    `<div class="error hidden" id="onboardErr"></div></form></div>`;

  document.getElementById("backMon").addEventListener(
    "click", () => showView("monitoring"));
  document.getElementById("discoverGroups").addEventListener(
    "click", async () => {
      const f = document.getElementById("onboardForm");
      const list = document.getElementById("groupList");
      const err = document.getElementById("onboardErr");
      err.classList.add("hidden");
      if (!f.api_token.value.trim()) {
        err.textContent = "Paste the API token first — discovery " +
          "authenticates with it (it is not stored by this call).";
        err.classList.remove("hidden");
        return;
      }
      list.innerHTML = '<div class="spinner"></div>';
      const r = await fetch("/api/v1/monitoring/sources/discover-groups", {
        method: "POST", credentials: "same-origin",
        headers: csrfHeaders(),
        body: JSON.stringify({
          provider_base_url: f.provider_base_url.value.trim(),
          api_token: f.api_token.value.trim(),
        }),
      });
      const resp = await r.json();
      if (!r.ok) {
        list.innerHTML = "";
        err.textContent = resp.detail
          ? (typeof resp.detail === "string" ? resp.detail
             : JSON.stringify(resp.detail))
          : "Discovery failed";
        err.classList.remove("hidden");
        return;
      }
      if (!resp.length) {
        list.innerHTML = "<span style='color:#8b93a5'>no host groups " +
          "visible to this token</span>";
        return;
      }
      const picked = new Set(
        f.host_group_refs.value.split(",").map(s => s.trim())
          .filter(Boolean));
      list.innerHTML =
        `<div class="groupbox"><div class="gb-head">` +
        `<span>${resp.length} host group(s) — select the scope</span>` +
        `<span><a id="gbAll">select all</a>` +
        `<a id="gbNone">clear</a></span>` +
        `</div>` +
        resp.map(g =>
          `<label class="grouppick">` +
          `<input type="checkbox" class="grpPick" value="${g.groupid}"` +
          `${picked.has(g.groupid) ? " checked" : ""}> ` +
          `<span>${g.name || "(unnamed)"}</span>` +
          `<span class="gid">${g.groupid}</span></label>`).join("") +
        `</div>`;
      document.getElementById("gbAll").onclick = () => {
        list.querySelectorAll(".grpPick")
          .forEach(c => c.checked = true);
        list.onchange();
      };
      document.getElementById("gbNone").onclick = () => {
        list.querySelectorAll(".grpPick")
          .forEach(c => c.checked = false);
        list.onchange();
      };
      list.onchange = () => {
        f.host_group_refs.value =
          [...list.querySelectorAll(".grpPick:checked")]
            .map(c => c.value).join(",");
      };
    });
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
      if (f.api_token.value.trim())
        body.api_token = f.api_token.value.trim();
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
      showView("monitoring");  // validation op enqueued with the source
    });
}

async function loadSourceDetail(sourceId, tid) {
  const det = root;
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
        `<td>${fmtTs(o.created_at)}</td>` +
        `<td>${badStates.has(o.state)
            ? `<button class="secondary op-requeue" data-op="${esc(o.monitoring_sync_operation_id)}">retry</button>`
            : ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">No operations</td></tr>`;

  det.innerHTML =
    `<div class="viewhead"><button class="backbtn" id="backMon">` +
    `&#8592; monitoring</button>` +
    `<h2>Source ${esc(sourceId.slice(0, 24))}</h2></div>` +
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
  document.getElementById("backMon").addEventListener("click", () =>
    showView("monitoring"));
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
  const det = root;
  det.innerHTML = '<div class="spinner"></div>';
  const [detail, timeline, notifications, incidents] =
    await Promise.all([
      alerting(`/alerts/${alertId}`, tid),
      alerting(`/alerts/${alertId}/timeline`, tid),
      alerting(`/notifications`, tid),
      alerting(`/alerts/${alertId}/incidents`, tid),
    ]);
  if (!detail) {
    det.innerHTML = '<p class="empty">Alert unavailable.</p>';
    return;
  }
  const a = detail.alert;
  const transitions = (detail.transitions || []).map(t =>
    `<li><span class="t-kind">${esc(t.to_lifecycle_state)}</span> ` +
    `at r${esc(t.source_revision)} ` +
    `<span class="t-at">${fmtTs(t.occurred_at)}</span></li>`
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
    `<span class="t-at">${fmtTs(e.at)}</span></li>`
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

  const incRows = (incidents || []).length
    ? (incidents || []).map(i =>
        `<tr><td><button class="link" data-inc="` +
        `${esc(i.incident_id)}">${esc(i.incident_id.slice(0, 26))}` +
        `</button></td>` +
        `<td>${esc(i.title)}</td>` +
        `<td class="a-${esc(i.lifecycle_state)}">` +
        `${esc(i.lifecycle_state)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">No incidents</td></tr>`;

  det.innerHTML =
    `<div class="viewhead"><button class="backbtn" id="backAlerts">` +
    `&#8592; alerts</button><h2>Alert</h2>` +
    `<code>${esc(alertId.slice(0, 18))}</code></div>` +
    `<div class="panel"><div class="section" style="margin-top:0;border:0;padding:0">` +
    `<p class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</p>` +
    `<p class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</p>` +
    `<div class="meta">policy <code>${esc(a.policy_id)}</code> ` +
    `v${esc(a.policy_version)} (pinned) · subject ` +
    `<code>${esc((a.source_subject_id || "").slice(0, 28))}</code> · ` +
    `occurrence r${esc(a.source_occurrence_revision)} · ` +
    `current r${esc(a.current_source_revision)}</div>` +
    `<ul class="timeline">${transitions}</ul></div></div>` +

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
    `</p><div id="notifyForm"></div></div>` +

    `<div class="section"><h2>ITSM incidents</h2>` +
    `<table><thead><tr><th>Incident</th><th>Title</th>` +
    `<th>State</th></tr></thead>` +
    `<tbody>${incRows}</tbody></table>` +
    `<div class="actions">` +
    `<button class="secondary" id="btnNewIncident">` +
    `create incident</button></div>` +
    `<div id="incidentDetail"></div></div>`;

  document.getElementById("backAlerts").addEventListener(
    "click", () => showView("alerts"));
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

  document.getElementById("btnNewIncident")
    .addEventListener("click", () => {
      document.getElementById("incidentDetail").innerHTML =
        `<form id="incForm">` +
        `<label>Title<input name="title" required maxlength="240" ` +
        `placeholder="incident title"></label>` +
        `<label>Description<input name="desc" maxlength="8000" ` +
        `placeholder="optional"></label>` +
        `<button type="submit">Create incident</button></form>` +
        `<p class="note">Incident lifecycle is independent — it never ` +
        `changes the alert. A durable provider sync is enqueued on ` +
        `creation.</p>`;
      document.getElementById("incForm").addEventListener(
        "submit", async (ev) => {
          ev.preventDefault();
          const r = await post(
            `/alerts/${alertId}/incidents`, tid, {
              title: ev.target.title.value.trim(),
              description: ev.target.desc.value.trim() || null,
            });
          if (!r.ok) fail("Incident denied (alert must be active).");
          else reload();
        });
    });

  document.querySelectorAll("[data-inc]").forEach(b =>
    b.addEventListener("click", () =>
      loadIncidentDetail(b.dataset.inc, tid, alertId, reload)));
}

async function loadIncidentDetail(incidentId, tid, alertId, reload) {
  const el = document.getElementById("incidentDetail");
  el.innerHTML = '<div class="spinner"></div>';
  const inc = await alerting(`/incidents/${incidentId}`, tid);
  if (!inc) {
    el.innerHTML = '<p class="empty">Incident unavailable.</p>';
    return;
  }
  const sync = inc.provider_sync || {};
  const trs = (inc.transitions || []).map(t =>
    `<li><span class="t-kind">${esc(t.to_state)}</span> ` +
    `${esc(t.actor_principal_id)} ` +
    `<span class="t-at">${fmtTs(t.occurred_at)}` +
    `</span></li>`).join("") || '<li class="empty">none</li>';
  const asg = (inc.assignments || []).map(a =>
    `<li>${esc(a.assignee_principal_id)} ` +
    `${a.effective_until
        ? '<span class="t-at">until ' +
          fmtTs(a.effective_until) + "</span>"
        : '<span class="t-kind">current</span>'}</li>`).join("") ||
    '<li class="empty">unassigned</li>';
  const cmts = (inc.comments || []).map(c =>
    `<li>${esc(c.body)} — ${esc(c.actor_principal_id)} ` +
    `<span class="t-at">${fmtTs(c.created_at)}` +
    `</span></li>`).join("") || '<li class="empty">no comments</li>';

  const next = {open: ["in_progress", "resolved"],
                in_progress: ["resolved"],
                resolved: ["closed"], closed: []}[inc.lifecycle_state] || [];

  el.innerHTML =
    `<h3>${esc(inc.title)} <span class="a-${esc(inc.lifecycle_state)}">` +
    `${esc(inc.lifecycle_state)}</span></h3>` +
    `<div class="meta"><code>${esc(inc.incident_id)}</code> · alert ` +
    `<code>${esc(inc.alert_id.slice(0, 18))}</code></div>` +
    `<p class="meta">provider sync ` +
    `<strong>${esc(sync.sync_state || "unknown")}</strong>` +
    (sync.provider_ticket_ref
      ? ` · ticket <code>${esc(sync.provider_ticket_ref)}</code>` : "") +
    ` · attempt ${esc(sync.attempt_number || 0)}` +
    (sync.last_failure_class
      ? ` · <span class="flag bad">${esc(sync.last_failure_class)}</span>`
      : "") + `</p>` +
    `<h4>Transitions</h4><ul class="timeline">${trs}</ul>` +
    `<h4>Assignments</h4><ul class="timeline">${asg}</ul>` +
    `<h4>Comments</h4><ul class="timeline">${cmts}</ul>` +
    `<div class="actions">` +
    next.map(s =>
      `<button class="secondary" data-tr="${esc(s)}">${esc(s)}</button>`
    ).join("") +
    `<button class="secondary" id="btnIncAssign">assign</button>` +
    `<button class="secondary" id="btnIncComment">comment</button>` +
    `</div><div id="incForm2"></div>`;

  document.querySelectorAll("[data-tr]").forEach(b =>
    b.addEventListener("click", async () => {
      const r = await post(`/incidents/${incidentId}/transition`,
                           tid, {target_state: b.dataset.tr});
      if (!r.ok) fail("Transition denied.");
      else reload();
    }));
  document.getElementById("btnIncAssign").addEventListener(
    "click", async () => {
      const p = prompt("Assignee principal id");
      if (!p) return;
      const r = await post(`/incidents/${incidentId}/assignments`,
                           tid, {assignee_principal_id: p.trim()});
      if (!r.ok) fail("Assign denied."); else reload();
    });
  document.getElementById("btnIncComment").addEventListener(
    "click", async () => {
      const body = prompt("Comment");
      if (!body) return;
      const r = await post(`/incidents/${incidentId}/comments`,
                           tid, {body});
      if (!r.ok) fail("Comment denied."); else reload();
    });
}

// ---------------------------------------------------------------------------
// Administration — tenant members + custom roles + platform view
// ---------------------------------------------------------------------------

const ROLE_TEMPLATES = ["admin", "operator", "viewer", "auditor"];
const ALL_PERMISSIONS = [
  "tenant:read", "tenant:admin",
  "monitoring:read", "monitoring:operate",
  "alerting:read", "alerting:operate",
  "observability:read", "audit:read",
];

function tapi(path, method, body) {
  return fetch(`/api/v1${path}`, {
    method: method || "GET", credentials: "same-origin",
    headers: csrfHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function loadAdmin(s) {
  const el = root;
  el.innerHTML = `<div class="viewhead"><h2>Administration</h2></div>` +
    `<div id="adminBody"><div class="spinner"></div></div>`;
  const body = document.getElementById("adminBody");
  const [mRes, rRes, oRes, gRes] = await Promise.all([
    tapi("/tenant/members"), tapi("/tenant/roles"),
    tapi("/platform/organizations"),
    tapi("/platform/delegated-grants"),
  ]);
  const members = mRes.ok ? await mRes.json() : null;
  const roles = rRes.ok ? await rRes.json() : null;
  const platformOk = oRes.ok;
  const orgs = platformOk ? await oRes.json() : null;
  const grants = gRes.ok ? await gRes.json() : [];

  if (members === null) {
    body.innerHTML = '<p class="empty">tenant:read required ' +
      'for administration.</p>';
    return;
  }

  const memberRows = members.length
    ? members.map(m =>
        `<tr><td><code>${esc(m.principal_id)}</code></td>` +
        `<td>${esc(m.role)}</td><td>${esc(m.state)}</td>` +
        `<td>${m.state === "active"
          ? `<button class="link" data-revoke="${esc(m.membership_id)}">` +
            `revoke</button>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">no members</td></tr>`;

  const roleRows = (roles || []).length
    ? (roles || []).map(r =>
        `<tr><td><code>${esc(r.role_name)}</code></td>` +
        `<td>${esc((r.permissions || []).join(", "))}</td>` +
        `<td>${esc(r.state)}</td>` +
        `<td>${r.state === "active"
          ? `<button class="link" data-retire="${esc(r.role_name)}">` +
            `retire</button>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">no custom roles</td></tr>`;

  const roleOptions = ROLE_TEMPLATES.map(r => `<option>${r}</option>`)
    .join("") + (roles || [])
      .filter(r => r.state === "active")
      .map(r => `<option>custom:${esc(r.role_name)}</option>`).join("");

  const permBoxes = ALL_PERMISSIONS.map(p =>
    `<label style="display:inline-block;margin:.15rem .6rem .15rem 0;` +
    `font-size:.75rem"><input type="checkbox" name="perm" ` +
    `value="${esc(p)}"> ${esc(p)}</label>`).join("");

  let platformHtml;
  if (!platformOk) {
    platformHtml = '<p class="empty">platform admin required for ' +
      'organizations and delegated grants.</p>';
  } else {
    const orgRows = (orgs || []).map(o =>
      `<tr><td><code>${esc(o.organization_id)}</code></td>` +
      `<td>${esc(o.display_name)}</td>` +
      `<td>${esc(o.state)}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="empty">no organizations</td></tr>`;
    const grantRows = (grants || []).map(g =>
      `<tr><td><code>${esc(g.principal_id)}</code></td>` +
      `<td>${esc(g.source_organization_id)} ` +
      `&rarr; <code>${esc(g.target_tenant_id)}</code></td>` +
      `<td>${esc((g.permissions || []).join(", "))}</td>` +
      `<td>${esc(g.state || "")}</td></tr>`).join("") ||
      `<tr><td colspan="4" class="empty">no delegated grants</td></tr>`;
    platformHtml =
      `<h4>Organizations</h4><table><tbody>${orgRows}</tbody></table>` +
      `<h4>Delegated grants</h4><table><tbody>${grantRows}</tbody>` +
      `</table>`;
  }

  body.innerHTML =
    `<div class="panel"><h4>Members</h4>` +
    `<table><thead><tr><th>Principal</th><th>Role</th><th>State</th>` +
    `<th></th></tr></thead><tbody>${memberRows}</tbody></table>` +
    `<form id="memberForm"><div style="display:flex;gap:.5rem">` +
    `<input name="principal" required placeholder="principal.…" ` +
    `style="flex:1"><select name="role" style="width:auto">` +
    `${roleOptions}</select>` +
    `<button type="submit">add / update</button></div></form>` +

    `<h4>Custom roles</h4>` +
    `<table><thead><tr><th>Role</th><th>Permissions</th>` +
    `<th>State</th><th></th></tr></thead>` +
    `<tbody>${roleRows}</tbody></table>` +
    `<form id="roleForm"><input name="name" required ` +
    `placeholder="role name"><div>${permBoxes}</div>` +
    `<button type="submit">create role</button></form>` +

    `</div><div class="panel"><h4>Platform</h4>${platformHtml}</div>`;

  body.querySelectorAll("[data-revoke]").forEach(b =>
    b.addEventListener("click", async () => {
      const r = await tapi(`/tenant/members/${b.dataset.revoke}/revoke`,
                           "POST");
      if (!r.ok) fail("Revoke denied."); else loadAdmin(s);
    }));
  body.querySelectorAll("[data-retire]").forEach(b =>
    b.addEventListener("click", async () => {
      const r = await tapi(`/tenant/roles/${b.dataset.retire}/retire`,
                           "POST");
      if (!r.ok) fail("Retire denied."); else loadAdmin(s);
    }));

  document.getElementById("memberForm").addEventListener(
    "submit", async (ev) => {
      ev.preventDefault();
      const r = await tapi("/tenant/members", "POST", {
        principal_id: ev.target.principal.value.trim(),
        role: ev.target.role.value,
      });
      if (!r.ok) fail("Member grant denied (tenant:admin required).");
      else loadAdmin(s);
    });
  document.getElementById("roleForm").addEventListener(
    "submit", async (ev) => {
      ev.preventDefault();
      const perms = [...ev.target.querySelectorAll(
        "input[name=perm]:checked")].map(c => c.value);
      const r = await tapi("/tenant/roles", "POST", {
        name: ev.target.name.value.trim(), permissions: perms,
      });
      if (!r.ok) fail("Role create denied (tenant:admin required).");
      else loadAdmin(s);
    });
}

document.querySelectorAll(".navbtn").forEach(b =>
  b.addEventListener("click", () => showView(b.dataset.view)));

// Surface auth errors from the callback redirect (e.g. /?error=forbidden)
const params = new URLSearchParams(location.search);
if (params.get("error") === "forbidden") fail("Access denied.");
if (params.get("error") === "auth_failed") fail("Authentication failed. Try again.");

refresh();
