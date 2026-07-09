import { buildPushPayload } from "@block65/webcrypto-web-push";

const JSON_HEADERS = { "content-type": "application/json" };
const NOTIFY_URL = "https://eduf.me/notify.json";
const LAST_KEY = "meta:last-notified";

async function hashEndpoint(endpoint) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint)
  );
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readSubscription(request) {
  const sub = await request.json().catch(() => null);
  if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
    return null;
  }
  return sub;
}

// Envia uma notificação para todas as subscriptions. Remove as mortas (404/410).
async function sendToAll(env, notification) {
  const vapid = {
    subject: "mailto:eduf@eduf.me",
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  const message = {
    data: JSON.stringify(notification),
    options: { ttl: 86400 }
  };

  let ok = 0, removed = 0, failed = 0;
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const { name } of page.keys) {
      const raw = await env.SUBS.get(name);
      if (!raw) continue;
      try {
        const sub = JSON.parse(raw);
        const payload = await buildPushPayload(message, sub, vapid);
        const res = await fetch(sub.endpoint, payload);
        if (res.status === 404 || res.status === 410) {
          await env.SUBS.delete(name);
          removed++;
        } else if (res.status >= 200 && res.status < 300) {
          ok++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { ok, removed, failed };
}

// Cron: compara o post mais recente do notify.json com o último notificado.
// Primeira execução (KV vazia) só registra o estado — não notifica post antigo.
async function checkAndNotify(env) {
  const res = await fetch(NOTIFY_URL, { headers: { "user-agent": "eduf-push-cron" } });
  if (!res.ok) return { skipped: `notify.json HTTP ${res.status}` };
  const posts = await res.json();
  if (!Array.isArray(posts) || posts.length === 0) return { skipped: "empty" };

  const newest = posts[0];
  const last = await env.SUBS.get(LAST_KEY);
  if (last === newest.url) return { skipped: "no new post" };

  let result = { skipped: "first run, state recorded" };
  if (last !== null) {
    result = await sendToAll(env, {
      title: newest.title,
      body: newest.description || "",
      url: newest.url
    });
  }
  await env.SUBS.put(LAST_KEY, newest.url);
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/api/push/subscribe") {
      const sub = await readSubscription(request);
      if (!sub) return json({ error: "invalid subscription" }, 400);
      await env.SUBS.put("sub:" + (await hashEndpoint(sub.endpoint)), JSON.stringify(sub));
      return json({ ok: true });
    }

    if (url.pathname === "/api/push/unsubscribe") {
      const sub = await readSubscription(request);
      if (!sub) return json({ error: "invalid subscription" }, 400);
      await env.SUBS.delete("sub:" + (await hashEndpoint(sub.endpoint)));
      return json({ ok: true });
    }

    if (url.pathname === "/api/push/send-test") {
      if (request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
        return json({ error: "forbidden" }, 403);
      }
      const result = await sendToAll(env, {
        title: "Teste — eduf.me",
        body: "Se você está vendo isto, as notificações funcionam.",
        url: "https://eduf.me/"
      });
      return json(result);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env));
  }
};
