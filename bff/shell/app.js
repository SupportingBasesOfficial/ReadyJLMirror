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
let detailSeq = 0;

// Effective permissions projected to UI capabilities. The API is the
// authoritative gate — this only decides which controls to render.
function caps() {
  const p = (sessionState && sessionState.permissions) || [];
  return {
    monitorOp: p.includes("monitoring:operate"),
    alertOp: p.includes("alerting:operate"),
    admin: p.includes("tenant:admin"),
  };
}

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
  const r = await fetch(
    `/api/v1/monitoring/sources/${sourceId}/${kind}?tenant_id=${tenantId}`,
    { method: "POST", credentials: "same-origin", headers: csrfHeaders() });
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return body.monitoring_sync_operation_id || true;
}

// After enqueue, follow the enqueued ops: one reload to show them
// pending/running, one final reload when they settle. A single
// watcher per rendered detail accumulates the op ids of every
// click, so several buttons do not start parallel reload loops.
// `seq` keeps stale watchers from yanking the user back after
// navigating away.
let opWatch = null;

function watchSourceOps(sourceId, tid, seq, opId) {
  if (!opWatch || opWatch.seq !== seq || !opWatch.alive) {
    opWatch = { seq, sourceId, tid, opIds: new Set(), alive: true };
    runOpWatch(opWatch);
  }
  if (typeof opId === "string") opWatch.opIds.add(opId);
}

async function runOpWatch(w) {
  try {
    await new Promise(r => setTimeout(r, 2500));
    if (w.seq !== detailSeq) return;
    await loadSourceDetail(w.sourceId, w.tid, w.seq);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (w.seq !== detailSeq) return;
      let ops;
      try {
        ops = await api(
          `/sources/${w.sourceId}/operations?tenant_id=${w.tid}`);
      } catch { return; }
      if (!Array.isArray(ops)) return;
      for (const o of ops) {
        if (w.opIds.has(o.monitoring_sync_operation_id)
            && o.state !== "pending" && o.state !== "running")
          w.opIds.delete(o.monitoring_sync_operation_id);
      }
      if (w.opIds.size === 0) {
        if (w.seq === detailSeq)
          await loadSourceDetail(w.sourceId, w.tid, w.seq);
        return;
      }
    }
  } finally {
    w.alive = false;
  }
}

async function loadMonitoring(s) {
  const tid = s.tenant.tenant_id;
  render(
    `<div class="viewhead"><h2>Monitoring sources</h2>` +
    `<span class="spacer"></span>` +
    (caps().monitorOp
      ? `<button class="secondary small" id="addSource">` +
        `+ add source</button>`
      : "") +
    `</div><div id="monBody"><div class="spinner"></div></div>`);
  const addBtn = document.getElementById("addSource");
  if (addBtn) addBtn.addEventListener(
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

let detailTab = "overview";   // active source-detail tab
let showAllOps = false;       // ops table expanded — survives silent refresh
let detailFilters = {};       // per-tab filter state — survives refresh
let detailFilterSource = "";  // filters reset when another source opens

async function loadSourceDetail(sourceId, tid, seq) {
  // Watcher-triggered reloads pass seq — keep the current DOM until
  // the fresh render is ready so the page never flashes a spinner.
  const bg = seq !== undefined;
  if (seq === undefined) seq = ++detailSeq;
  else detailSeq = seq;
  const det = root;
  const scrollY = window.scrollY;
  if (!bg) det.innerHTML = '<div class="spinner"></div>';
  // Contract list endpoints return {items, next_cursor}; the shell
  // uses view=operational for internal fields (groups, provider refs).
  const [source, healthR, problemsR, currentR, ops, alerts, resourcesR] =
    await Promise.all([
      api(`/sources/${sourceId}?tenant_id=${tid}`),
      api(`/sources/${sourceId}/health?tenant_id=${tid}&view=operational`),
      api(`/sources/${sourceId}/problems?tenant_id=${tid}&active_only=true&view=operational`),
      api(`/sources/${sourceId}/current?tenant_id=${tid}&view=operational`),
      api(`/sources/${sourceId}/operations?tenant_id=${tid}`),
      fetch(`/api/v1/alerting/alerts?tenant_id=${tid}&source_id=${sourceId}&limit=200`,
            { credentials: "same-origin" })
          .then(r => r.ok ? r.json() : []),
      api(`/sources/${sourceId}/resources?tenant_id=${tid}&view=operational`),
    ]);
  const health = healthR && healthR.items;
  const problems = problemsR && problemsR.items;
  const current = currentR && currentR.items;
  const resources = resourcesR && resourcesR.items;
  if (seq !== detailSeq) return;
  if (detailFilterSource !== sourceId) {
    detailFilters = {};
    detailFilterSource = sourceId;
  }

  const resNames = {}, healthByRes = {};
  if (Array.isArray(resources)) for (const r of resources)
    resNames[r.monitoring_resource_id] = r.display_name;
  if (Array.isArray(health)) for (const h of health)
    healthByRes[h.monitoring_resource_id] = h;
  const src = (source && !Array.isArray(source)) ? source : {};
  const nRes = Array.isArray(resources) ? resources.length : 0;
  const nProb = Array.isArray(problems) ? problems.length : 0;

  const stat = (label, val, cls) =>
    `<div class="stat"><div class="statv${cls ? " " + cls : ""}">` +
    `${esc(String(val))}</div><div class="statl">${esc(label)}</div></div>`;
  const kv = (k, v) =>
    `<tr><td class="kvk">${esc(k)}</td>` +
    `<td>${v == null || v === "" ? "—" : esc(String(v))}</td></tr>`;

  const hCount = {};
  if (Array.isArray(health)) for (const h of health)
    hCount[h.health_class] = (hCount[h.health_class] || 0) + 1;
  const scopeGroups = src.configured_provider_scope
    && Array.isArray(src.configured_provider_scope.host_group_refs)
    ? src.configured_provider_scope.host_group_refs.length : null;

  const tabHtml = {};

  tabHtml.overview =
    `<div class="statgrid">` +
    stat("hosts", nRes) +
    stat("healthy", hCount.healthy || 0, "h-healthy") +
    stat("degraded", hCount.degraded || 0, "h-degraded") +
    stat("unhealthy", hCount.unhealthy || 0, "h-unhealthy") +
    stat("active problems", nProb, nProb ? "sev-warning" : "") +
    stat("alerts", Array.isArray(alerts) ? alerts.length : 0) +
    `</div>` +
    `<div class="section"><h2>Source</h2><table><tbody>` +
    kv("display name", src.display_name) +
    kv("provider", src.provider_instance_ref) +
    kv("base url", src.provider_base_url) +
    kv("evidence", src.operational_evidence_state) +
    kv("credential binding", src.credential_binding_ref) +
    kv("scope groups", scopeGroups) +
    kv("last successful sync", fmtTs(src.last_successful_sync_at)) +
    kv("last attempt", fmtTs(src.last_attempt_at)) +
    `</tbody></table></div>`;

  const hostRowHtml = r => {
    const h = healthByRes[r.monitoring_resource_id] || {};
    const hc = h.health_class || "unknown";
    return `<tr><td>${esc(r.display_name
          || r.monitoring_resource_id)}` +
      `<div class="dim">${esc(r.monitoring_resource_id.slice(0, 20))}` +
      `</div></td>` +
      `<td><code>${esc(r.provider_external_ref)}</code></td>` +
      `<td class="h-${esc(hc)}">${esc(hc)}</td>` +
      `<td>${esc(r.scope_state)}</td>` +
      `<td>${esc(r.presence_state)}</td>` +
      `<td>${fmtTs(r.last_observed_at)}</td></tr>`;
  };
  const resList = Array.isArray(resources) ? resources : [];
  const probList = Array.isArray(problems) ? problems : [];
  // Host-group membership (provider refs + names) per resource —
  // powers the group filter on hosts/problems.
  const resGroups = {};
  const groupUnion = {};
  for (const r of resList) {
    const gs = Array.isArray(r.host_groups) ? r.host_groups : [];
    resGroups[r.monitoring_resource_id] = gs;
    // Removed hosts keep their membership recorded but must not feed
    // the group filter — a group with only ghosts is a dead option.
    if (r.presence_state !== "removed")
      for (const g of gs) groupUnion[g.ref] = g.name || g.ref;
  }
  const groupOpts = Object.entries(groupUnion)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([ref, name]) =>
      `<option value="${esc(ref)}">${esc(name)}</option>`).join("");
  const groupSel = `<select id="flt-sel2">` +
    `<option value="">all groups</option>${groupOpts}</select>`;
  const hostHealths = [...new Set(resList.map(r =>
    (healthByRes[r.monitoring_resource_id] || {}).health_class
      || "unknown"))].sort();
  tabHtml.hosts =
    `<div class="section"><div class="filterbar">` +
    `<input id="flt-text" placeholder="filter host / provider ref…">` +
    `<select id="flt-sel"><option value="">all health</option>` +
    hostHealths.map(h => `<option>${esc(h)}</option>`).join("") +
    `</select>${groupSel}<span class="hint" id="flt-count"></span></div>` +
    `<table><thead><tr><th>Host</th>` +
    `<th>Provider ref</th><th>Health</th><th>Scope</th>` +
    `<th>Presence</th><th>Last seen</th></tr></thead>` +
    `<tbody id="flt-body"></tbody></table></div>`;

  const problemRowHtml = p =>
    `<tr><td class="sev-${esc(p.severity_class)}">` +
    `${esc(p.severity_class)}</td>` +
    `<td>${esc(resNames[p.monitoring_resource_id] || "—")}</td>` +
    `<td>${esc(p.summary)}</td>` +
    `<td><code>${esc(p.provider_eventid)}</code></td>` +
    `<td>${esc(p.evidence_state)}</td></tr>`;
  const sevs = [...new Set(probList.map(p => p.severity_class))].sort();
  tabHtml.problems =
    `<div class="section"><div class="filterbar">` +
    `<input id="flt-text" placeholder="filter host / summary…">` +
    `<select id="flt-sel"><option value="">all severities</option>` +
    sevs.map(s => `<option>${esc(s)}</option>`).join("") +
    `</select>${groupSel}<span class="hint" id="flt-count"></span></div>` +
    `<table><thead><tr><th>Severity</th>` +
    `<th>Host</th><th>Summary</th><th>Event</th><th>Evidence</th>` +
    `</tr></thead><tbody id="flt-body"></tbody></table></div>`;

  const cur = Array.isArray(current) ? current : [];
  const metricRowHtml = c =>
    `<tr><td>${esc(c.name || c.metric_definition_id)}</td>` +
    `<td><code>${esc(typeof c.value === "object"
        ? JSON.stringify(c.value) : c.value)}</code></td>` +
    `<td>${esc(c.evidence_state)}</td></tr>`;
  tabHtml.metrics =
    `<div class="section"><div class="filterbar">` +
    `<input id="flt-text" placeholder="filter metric name…">` +
    `<span class="hint" id="flt-count"></span></div>` +
    `<table><thead><tr><th>Metric</th>` +
    `<th>Value</th><th>Evidence</th></tr></thead>` +
    `<tbody id="flt-body"></tbody></table></div>`;

  const alertList = Array.isArray(alerts) ? alerts : [];
  const alertRowHtml = a =>
    `<tr class="clickable" data-alert="${esc(a.alert_id)}">` +
    `<td class="a-${esc(a.lifecycle_state)}">${esc(a.lifecycle_state)}</td>` +
    `<td>${esc(resNames[a.monitoring_resource_id] || "—")}</td>` +
    `<td><code>${esc((a.alert_id || "").slice(0, 18))}</code></td>` +
    `<td>${esc(a.source_kind)}</td>` +
    `<td>${esc(a.policy_id)} v${esc(a.policy_version)}</td>` +
    `<td>r${esc(a.source_occurrence_revision)}</td></tr>`;
  const lifecycles = [...new Set(alertList.map(a => a.lifecycle_state))].sort();
  tabHtml.alerts =
    `<div class="section"><div class="filterbar">` +
    `<input id="flt-text" placeholder="filter host / policy / alert…">` +
    `<select id="flt-sel"><option value="">all states</option>` +
    lifecycles.map(l => `<option>${esc(l)}</option>`).join("") +
    `</select>${groupSel}<span class="hint" id="flt-count"></span></div>` +
    `<table><thead><tr><th>State</th><th>Host</th>` +
    `<th>Alert</th><th>Source kind</th><th>Policy</th><th>Rev</th>` +
    `</tr></thead><tbody id="flt-body"></tbody></table></div>`;

  const badStates = new Set(["reconciliation_required", "failed_terminal"]);
  const opList = Array.isArray(ops) ? ops : [];
  const opRow = (o, extra) =>
    `<tr class="${badStates.has(o.state) ? "op-bad " : ""}${extra || ""}">` +
    `<td class="op-${esc(o.state)}">${esc(o.state)}</td>` +
    `<td>${esc(o.responsibility_kind)}</td>` +
    `<td><code>${esc((o.monitoring_sync_operation_id || "").slice(0, 20))}</code></td>` +
    `<td>${esc(o.last_error_class)}</td>` +
    `<td>${fmtTs(o.created_at)}</td>` +
    `<td>${badStates.has(o.state) && caps().monitorOp
        ? `<button class="secondary op-requeue" ` +
          `data-op="${esc(o.monitoring_sync_operation_id)}">retry</button>`
        : ""}</td></tr>`;
  const opRows = !opList.length
    ? `<tr><td colspan="6" class="empty">No operations</td></tr>`
    : showAllOps
      ? opList.map(o => opRow(o)).join("")
      : opList.slice(0, 12).map(o => opRow(o)).join("") +
        opList.slice(12).map(o => opRow(o, "op-extra hidden")).join("") +
        (opList.length > 12
          ? `<tr><td colspan="6"><button class="secondary" ` +
            `id="showAllOps">show all ${opList.length} operations</button>` +
            `</td></tr>` : "");
  const syncBar = caps().monitorOp
    ? `<div class="actions opsync">` +
      `<span class="hint">sync now (operator override — the scheduler ` +
      `runs these on cadence automatically):</span>` +
      `<button class="secondary" data-p="inventory" ` +
      `title="Enqueue provider inventory sync">inventory</button>` +
      `<button class="secondary" data-p="metrics/poll" ` +
      `title="Enqueue metric definition poll">metrics</button>` +
      `<button class="secondary" data-p="current/poll" ` +
      `title="Enqueue current state poll">current</button>` +
      `<button class="secondary" data-p="history/poll" ` +
      `title="Enqueue metric history sync">history</button>` +
      `<button class="secondary" data-p="problems/poll" ` +
      `title="Enqueue problem state sync">problems</button></div>`
    : "";
  tabHtml.operations =
    `<div class="section">${syncBar}` +
    `<table><thead><tr><th>State</th>` +
    `<th>Kind</th><th>Op</th><th>Error class</th><th>Created</th>` +
    `<th></th></tr></thead><tbody>${opRows}</tbody></table></div>`;

  det.innerHTML =
    `<div class="viewhead"><button class="backbtn" id="backMon">` +
    `&#8592; monitoring</button>` +
    `<h2>${esc(src.display_name || sourceId.slice(0, 24))} ` +
    `<span class="dim">${esc(sourceId.slice(0, 24))}</span></h2></div>` +
    `<div class="tabbar">` +
    ["overview", "hosts", "problems", "metrics", "alerts", "operations"]
      .map(t => `<button class="tabbtn${t === detailTab
        ? " active" : ""}" data-tab="${t}">${t}</button>`).join("") +
    `</div><div id="tabBody"></div>`;

  const tabBody = det.querySelector("#tabBody");
  // Alert rows re-render on every filter keystroke — bind once via
  // delegation (det persists across silent re-renders) instead of
  // per-row listeners.
  if (!det._alertBound) {
    det._alertBound = true;
    det.addEventListener("click", e => {
      const tr = e.target.closest("[data-alert]");
      if (tr) loadAlertDetail(tr.dataset.alert, tid);
    });
  }

  // Live per-tab filtering: painters fill #flt-body from the already
  // fetched arrays; filter state lives in detailFilters so a silent
  // refresh keeps what the operator typed/selected.
  const paintFiltered = (el, items, match, rowHtml, emptyMsg, cap) => {
    const f = detailFilters[detailTab] ||= { text: "", sel: "" };
    const txt = el.querySelector("#flt-text");
    const sel = el.querySelector("#flt-sel");
    const sel2 = el.querySelector("#flt-sel2");
    if (txt && txt.value !== f.text) txt.value = f.text;
    if (sel && sel.value !== f.sel) sel.value = f.sel;
    if (sel2 && sel2.value !== (f.sel2 || "")) sel2.value = f.sel2 || "";
    const render = () => {
      const q = f.text.trim().toLowerCase();
      const rows = items.filter(i => match(i, q, f.sel, f.sel2));
      const shown = cap ? rows.slice(0, cap) : rows;
      el.querySelector("#flt-body").innerHTML = shown.length
        ? shown.map(rowHtml).join("")
        : `<tr><td colspan="9" class="empty">${emptyMsg}</td></tr>`;
      const cnt = el.querySelector("#flt-count");
      if (cnt) cnt.textContent = `${rows.length} of ${items.length}` +
        (cap && rows.length > cap ? ` — first ${cap}` : "");
    };
    if (txt) txt.addEventListener("input",
        () => { f.text = txt.value; render(); });
    if (sel) sel.addEventListener("change",
        () => { f.sel = sel.value; render(); });
    if (sel2) sel2.addEventListener("change",
        () => { f.sel2 = sel2.value; render(); });
    render();
  };
  const painters = {
    hosts: el => paintFiltered(el, resList,
      (r, q, sel, sel2) =>
        (!sel || ((healthByRes[r.monitoring_resource_id] || {})
            .health_class || "unknown") === sel) &&
        (!sel2 || (resGroups[r.monitoring_resource_id] || [])
            .some(g => g.ref === sel2)) &&
        (!q || (r.display_name || "").toLowerCase().includes(q) ||
              (r.provider_external_ref || "").includes(q)),
      hostRowHtml, "No resources match"),
    problems: el => paintFiltered(el, probList,
      (p, q, sel, sel2) =>
        (!sel || p.severity_class === sel) &&
        (!sel2 || (resGroups[p.monitoring_resource_id] || [])
            .some(g => g.ref === sel2)) &&
        (!q || (resNames[p.monitoring_resource_id] || "")
            .toLowerCase().includes(q) ||
              (p.summary || "").toLowerCase().includes(q)),
      problemRowHtml, "No problems match"),
    metrics: el => paintFiltered(el, cur,
      (c, q) => !q || (c.name || "").toLowerCase().includes(q),
      metricRowHtml, "No metrics match", 200),
    alerts: el => paintFiltered(el, alertList,
      (a, q, sel, sel2) =>
        (!sel || a.lifecycle_state === sel) &&
        (!sel2 || (resGroups[a.monitoring_resource_id] || [])
            .some(g => g.ref === sel2)) &&
        (!q || (resNames[a.monitoring_resource_id] || "")
            .toLowerCase().includes(q) ||
              (a.policy_id || "").toLowerCase().includes(q) ||
              (a.alert_id || "").toLowerCase().includes(q)),
      alertRowHtml, "No alerts match"),
  };

  const paintTab = () => {
    tabBody.innerHTML = tabHtml[detailTab];
    if (painters[detailTab]) painters[detailTab](tabBody);
    tabBody.querySelectorAll(".op-requeue").forEach(b =>
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
    const sa = tabBody.querySelector("#showAllOps");
    if (sa) sa.addEventListener("click", () => {
      showAllOps = true;
      tabBody.querySelectorAll(".op-extra")
        .forEach(r => r.classList.remove("hidden"));
      sa.closest("tr").remove();
    });
    tabBody.querySelectorAll("[data-p]").forEach(b =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        const opId = await poll(sourceId, b.dataset.p, tid);
        b.textContent = opId ? "queued" : "failed";
        if (!opId) { b.disabled = false; return; }
        watchSourceOps(sourceId, tid, seq, opId);
      }));
  };
  det.querySelectorAll(".tabbtn").forEach(b =>
    b.addEventListener("click", () => {
      detailTab = b.dataset.tab;
      det.querySelectorAll(".tabbtn").forEach(x =>
        x.classList.toggle("active", x === b));
      paintTab();
    }));
  paintTab();

  if (bg) window.scrollTo(0, scrollY);

  document.getElementById("backMon").addEventListener("click", () =>
    showView("monitoring"));

  // Near-real-time: silent refresh while the detail is on screen —
  // swaps in fresh data without spinner or scroll reset. Dies when
  // the user navigates (seq changes).
  setTimeout(() => {
    if (seq === detailSeq && currentView === "monitoring")
      loadSourceDetail(sourceId, tid, seq);
  }, 15000);
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
    (caps().alertOp
      ? `<div class="actions">` +
        `<button class="secondary" id="btnAck">acknowledge</button>` +
        `<button class="secondary" id="btnAssign">assign action</button>` +
        `<button class="secondary" id="btnVis">require native view` +
        `</button></div>`
      : "") +
    `<p class="note">ACK is evidence only — it never changes alert ` +
    `lifecycle or action ownership.</p>` +
    `<div id="opsForm"></div></div>` +

    `<div class="section"><h2>Notification delivery</h2>` +
    `<table><thead><tr><th>Delivery</th><th>Reason</th>` +
    `<th>Destination</th><th>Attempts</th></tr></thead>` +
    `<tbody>${notifRows}</tbody></table>` +
    `<div class="actions">` +
    (caps().alertOp
      ? `<button class="secondary" id="btnNotify">` +
        `notify via WhatsApp</button>`
      : "") +
    `<button class="secondary" id="btnAlertRefresh">refresh</button></div>` +
    `<p class="note">provider accepted ≠ delivered ≠ read. External read ` +
    `evidence is supplementary — it is not the authoritative native view.` +
    `</p><div id="notifyForm"></div></div>` +

    `<div class="section"><h2>ITSM incidents</h2>` +
    `<table><thead><tr><th>Incident</th><th>Title</th>` +
    `<th>State</th></tr></thead>` +
    `<tbody>${incRows}</tbody></table>` +
    (caps().alertOp
      ? `<div class="actions"><button class="secondary" ` +
        `id="btnNewIncident">create incident</button></div>`
      : "") +
    `<div id="incidentDetail"></div></div>`;

  document.getElementById("backAlerts").addEventListener(
    "click", () => showView("alerts"));
  const reload = () => loadAlertDetail(alertId, tid);
  document.getElementById("btnAlertRefresh")
    .addEventListener("click", reload);

  // Mutation controls exist only for alerting:operate — guard every
  // binding so viewer sessions render the detail without them.
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };

  on("btnAck", async () => {
    const note = prompt("ACK note (optional)") || null;
    const r = await post(`/alerts/${alertId}/ack`, tid, { note });
    if (!r.ok) fail("Acknowledge denied."); else reload();
  });

  on("btnAssign", () => {
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

  on("btnVis", () => {
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

  on("btnNotify", () => {
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

  on("btnNewIncident", () => {
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
    (caps().alertOp
      ? `<div class="actions">` +
        next.map(s =>
          `<button class="secondary" data-tr="${esc(s)}">${esc(s)}` +
          `</button>`).join("") +
        `<button class="secondary" id="btnIncAssign">assign</button>` +
        `<button class="secondary" id="btnIncComment">comment</button>` +
        `</div>`
      : "") +
    `<div id="incForm2"></div>`;

  document.querySelectorAll("[data-tr]").forEach(b =>
    b.addEventListener("click", async () => {
      const r = await post(`/incidents/${incidentId}/transition`,
                           tid, {target_state: b.dataset.tr});
      if (!r.ok) fail("Transition denied.");
      else reload();
    }));
  const incAssign = document.getElementById("btnIncAssign");
  if (incAssign) incAssign.addEventListener("click", async () => {
    const p = prompt("Assignee principal id");
    if (!p) return;
    const r = await post(`/incidents/${incidentId}/assignments`,
                         tid, {assignee_principal_id: p.trim()});
    if (!r.ok) fail("Assign denied."); else reload();
  });
  const incComment = document.getElementById("btnIncComment");
  if (incComment) incComment.addEventListener("click", async () => {
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

  const isAdmin = caps().admin;
  const memberRows = members.length
    ? members.map(m =>
        `<tr><td><code>${esc(m.principal_id)}</code></td>` +
        `<td>${esc(m.role)}</td><td>${esc(m.state)}</td>` +
        `<td>${m.state === "active" && isAdmin
          ? `<button class="link" data-revoke="${esc(m.membership_id)}">` +
            `revoke</button>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">no members</td></tr>`;

  const roleRows = (roles || []).length
    ? (roles || []).map(r =>
        `<tr><td><code>${esc(r.role_name)}</code></td>` +
        `<td>${esc((r.permissions || []).join(", "))}</td>` +
        `<td>${esc(r.state)}</td>` +
        `<td>${r.state === "active" && isAdmin
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
    (isAdmin
      ? `<form id="memberForm"><div style="display:flex;gap:.5rem">` +
        `<input name="principal" required placeholder="principal.…" ` +
        `style="flex:1"><select name="role" style="width:auto">` +
        `${roleOptions}</select>` +
        `<button type="submit">add / update</button></div></form>`
      : '<p class="hint">tenant:admin required to change ' +
        'memberships.</p>') +

    `<h4>Custom roles</h4>` +
    `<table><thead><tr><th>Role</th><th>Permissions</th>` +
    `<th>State</th><th></th></tr></thead>` +
    `<tbody>${roleRows}</tbody></table>` +
    (isAdmin
      ? `<form id="roleForm"><input name="name" required ` +
        `placeholder="role name"><div>${permBoxes}</div>` +
        `<button type="submit">create role</button></form>`
      : "") +

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

  const memberForm = document.getElementById("memberForm");
  if (memberForm) memberForm.addEventListener(
    "submit", async (ev) => {
      ev.preventDefault();
      const r = await tapi("/tenant/members", "POST", {
        principal_id: ev.target.principal.value.trim(),
        role: ev.target.role.value,
      });
      if (!r.ok) fail("Member grant denied (tenant:admin required).");
      else loadAdmin(s);
    });
  const roleForm = document.getElementById("roleForm");
  if (roleForm) roleForm.addEventListener(
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
