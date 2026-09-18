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
        `<div class="tenant"><span>${m.display_name}</span>` +
        `<button data-t="${m.tenant_id}" class="pick">Select</button></div>`).join("");
      render(`<p style="margin-bottom:.75rem">Select a tenant:</p>${items}`);
      document.querySelectorAll(".pick").forEach(b =>
        b.addEventListener("click", () => selectTenant(b.dataset.t)));
      meta.innerHTML = `<code>${s.principal_id}</code>`;
      break;
    }
    case "ready": {
      document.querySelector(".card").classList.add("wide");
      render(
        `<p>Signed in to <strong>${s.tenant.display_name}</strong></p>` +
        `<div class="meta" style="margin:1rem 0 1.25rem">` +
        `principal <code>${s.principal_id}</code> · role <code>${s.tenant.role}</code></div>` +
        `<div style="display:flex;gap:.5rem">` +
        `<button class="secondary" id="changeTenant">Change tenant</button>` +
        `<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>` +
        `</div>` +
        `<div class="section"><h2>Monitoring</h2><div id="mon">` +
        `<div class="spinner"></div></div></div>`);
      document.getElementById("changeTenant").addEventListener("click", async () => {
        render(`<p style="margin-bottom:.75rem">Select a tenant:</p>` +
          s.memberships.map(m =>
            `<div class="tenant"><span>${m.display_name}</span>` +
            `<button data-t="${m.tenant_id}" class="pick">Select</button></div>`).join(""));
        document.querySelectorAll(".pick").forEach(b =>
          b.addEventListener("click", () => selectTenant(b.dataset.t)));
      });
      meta.innerHTML = `authenticated at <code>${s.authenticated_at}</code>`;
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
  let sources;
  try {
    sources = await api(`/sources?tenant_id=${tid}`);
  } catch {
    mon.innerHTML = '<p class="empty">Monitoring unavailable.</p>';
    return;
  }
  const listHtml = (!Array.isArray(sources) || sources.length === 0)
    ? '<p class="empty">No monitoring sources configured.</p>'
    : `<table><thead><tr><th>Source</th><th>Provider</th>` +
      `<th>Evidence</th></tr></thead><tbody>` +
      sources.map(src =>
        `<tr class="clickable" data-src="${src.monitoring_source_id}">` +
        `<td>${src.display_name}</td>` +
        `<td><code>${src.provider_instance_ref}</code></td>` +
        `<td>${src.operational_evidence_state}</td></tr>`).join("") +
      `</tbody></table>`;

  mon.innerHTML =
    `<div class="actions"><button class="secondary" id="addSource">` +
    `+ add source</button></div>` + listHtml +
    `<div id="monDetail"></div>`;

  document.getElementById("addSource").addEventListener(
    "click", () => renderOnboardForm(tid));

  mon.querySelectorAll("[data-src]").forEach(row =>
    row.addEventListener("click", () =>
      loadSourceDetail(row.dataset.src, tid)));
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
  const [health, problems, current, ops] = await Promise.all([
    api(`/sources/${sourceId}/health?tenant_id=${tid}`),
    api(`/sources/${sourceId}/problems?tenant_id=${tid}&active_only=true`),
    api(`/sources/${sourceId}/current?tenant_id=${tid}`),
    api(`/sources/${sourceId}/operations?tenant_id=${tid}`),
  ]);

  const healthRows = Array.isArray(health) && health.length
    ? health.map(h =>
        `<tr><td><code>${h.monitoring_resource_id}</code></td>` +
        `<td class="h-${h.health_class}">${h.health_class}</td>` +
        `<td>${h.evidence_state}</td>` +
        `<td>r${h.projection_revision}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No health projections yet</td></tr>`;

  const problemRows = Array.isArray(problems) && problems.length
    ? problems.map(p =>
        `<tr><td class="sev-${p.severity_class}">${p.severity_class}</td>` +
        `<td>${p.summary || ""}</td>` +
        `<td><code>${p.provider_eventid || ""}</code></td>` +
        `<td>${p.evidence_state}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No active problems</td></tr>`;

  const currentRows = Array.isArray(current) && current.length
    ? current.slice(0, 20).map(c =>
        `<tr><td>${c.name || c.metric_definition_id}</td>` +
        `<td><code>${c.canonical_value}</code></td>` +
        `<td>${c.evidence_state}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">No current state</td></tr>`;

  const badStates = new Set(["reconciliation_required", "failed_terminal"]);
  const opRows = Array.isArray(ops) && ops.length
    ? ops.map(o =>
        `<tr class="${badStates.has(o.state) ? "op-bad" : ""}">` +
        `<td class="op-${o.state}">${o.state}</td>` +
        `<td>${o.responsibility_kind}</td>` +
        `<td><code>${(o.monitoring_sync_operation_id || "").slice(0, 20)}</code></td>` +
        `<td>${o.last_error_class || ""}</td>` +
        `<td>${o.created_at || ""}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No operations</td></tr>`;

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
    `<div class="section"><h2>Operations (DLQ)</h2>` +
    `<table><thead><tr><th>State</th><th>Kind</th><th>Op</th>` +
    `<th>Error class</th><th>Created</th></tr></thead>` +
    `<tbody>${opRows}</tbody></table></div>`;

  det.querySelectorAll("[data-p]").forEach(b =>
    b.addEventListener("click", async () => {
      await poll(sourceId, b.dataset.p, tid);
      b.disabled = true; b.textContent = "queued";
    }));
  document.getElementById("monRefresh").addEventListener("click", () =>
    loadSourceDetail(sourceId, tid));
}

// Surface auth errors from the callback redirect (e.g. /?error=forbidden)
const params = new URLSearchParams(location.search);
if (params.get("error") === "forbidden") fail("Access denied.");
if (params.get("error") === "auth_failed") fail("Authentication failed. Try again.");

refresh();
