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
      render(
        `<p>Signed in to <strong>${s.tenant.display_name}</strong></p>` +
        `<div class="meta" style="margin:1rem 0 1.25rem">` +
        `principal <code>${s.principal_id}</code> · role <code>${s.tenant.role}</code></div>` +
        `<div style="display:flex;gap:.5rem">` +
        `<button class="secondary" id="changeTenant">Change tenant</button>` +
        `<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>` +
        `</div>`);
      document.getElementById("changeTenant").addEventListener("click", async () => {
        render(`<p style="margin-bottom:.75rem">Select a tenant:</p>` +
          s.memberships.map(m =>
            `<div class="tenant"><span>${m.display_name}</span>` +
            `<button data-t="${m.tenant_id}" class="pick">Select</button></div>`).join(""));
        document.querySelectorAll(".pick").forEach(b =>
          b.addEventListener("click", () => selectTenant(b.dataset.t)));
      });
      meta.innerHTML = `authenticated at <code>${s.authenticated_at}</code>`;
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

// Surface auth errors from the callback redirect (e.g. /?error=forbidden)
const params = new URLSearchParams(location.search);
if (params.get("error") === "forbidden") fail("Access denied.");
if (params.get("error") === "auth_failed") fail("Authentication failed. Try again.");

refresh();
