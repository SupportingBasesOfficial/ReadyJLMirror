function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )jl_csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken(),
    ...extra,
  };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: headers(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent("jlm:session-expired"));
    }
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

export async function logout(): Promise<void> {
  try {
    const res = await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrfToken() },
      redirect: "manual",
    });
    // 2xx or opaque redirect (manual) both mean BFF retired the session.
    // Non-2xx that is NOT a redirect means the session was NOT retired —
    // still navigate away so the user isn't stuck, but the cookie may
    // remain valid until it expires server-side.
    if (!res.ok && res.type !== "opaqueredirect") {
      console.warn("[logout] BFF returned", res.status, "— session may still be active");
    }
  } catch {
    // Network failure: navigate anyway; server TTL will expire the cookie.
    console.warn("[logout] network error — navigating anyway");
  }
  window.location.href = "/";
}
