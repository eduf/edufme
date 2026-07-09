# Notificações Push — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notificações de navegador para novos artigos (`type: post`) do eduf.me, com opt-in via página dedicada — nunca prompt automático.

**Architecture:** Worker Cloudflare separado (`eduf-push`) com rotas `eduf.me/api/push/*`, KV para subscriptions e cron a cada 15 min que lê um `/notify.json` gerado pelo Eleventy. No site: service worker mínimo, página `/notificacoes/`, JS externo (CSP não permite inline), dois links novos no menu.

**Tech Stack:** Cloudflare Workers + KV + cron triggers, `@block65/webcrypto-web-push` (VAPID via WebCrypto), Eleventy 3.x (Nunjucks), Web Push API.

**Spec:** `docs/superpowers/specs/2026-07-09-push-notifications-design.md`

**Contexto que o executor precisa saber:**
- Repo é um blog Eleventy dentro de vault Obsidian. Site deployado via Workers Builds no push pra `main`.
- CSP definida via `<meta>` em `src/_includes/layouts/base.njk` (linha ~9): `script-src 'self'` + um sha256 (script anti-FOUC). Todo JS novo deve ser arquivo externo servido do próprio domínio. `connect-src` não declarado → herda `default-src 'self'` → fetch same-origin pra `/api/push/*` funciona.
- Transforms de dithering só tocam saída `.html` — JSON passa intocado.
- QUIRK: as collections por tipo em `eleventy.config.js` usam `getFilteredByTag(type)`, mas os posts declaram `type: post` no frontmatter (não como tag). Por isso este plano filtra por `item.data.type` diretamente. Não corrigir o quirk — fora do escopo.
- Testes: repo não tem framework de teste. Verificação é por comandos com saída esperada (build + jq, `wrangler dev` + curl, navegador real).

---

### Task 1: Scaffold do Worker `eduf-push` + chaves VAPID

**Files:**
- Create: `workers/push/package.json`
- Create: `workers/push/wrangler.jsonc`
- Create: `workers/push/.gitignore`

- [ ] **Step 1: Gerar par de chaves VAPID**

```bash
cd workers/push 2>/dev/null || mkdir -p workers/push && cd workers/push
npx web-push generate-vapid-keys
```

Expected: imprime `Public Key:` e `Private Key:` (base64url). **Guardar os dois valores** — pública vai no `push.js` (Task 5) e como secret; privada só como secret. Não commitar a privada em lugar nenhum.

- [ ] **Step 2: Criar `workers/push/package.json`**

```json
{
  "name": "eduf-push",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --test-scheduled",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@block65/webcrypto-web-push": "^1.0.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 3: Criar namespace KV**

```bash
cd workers/push && npx wrangler kv namespace create SUBS
```

Expected: imprime bloco com `id = "<hex>"`. Copiar o id pro próximo step. (Pode pedir `wrangler login` antes — fluxo de browser.)

- [ ] **Step 4: Criar `workers/push/wrangler.jsonc`** (substituir `KV_ID_AQUI` pelo id do Step 3)

```jsonc
{
  "name": "eduf-push",
  "main": "src/index.js",
  "compatibility_date": "2026-07-01",
  "routes": [
    { "pattern": "eduf.me/api/push/*", "zone_name": "eduf.me" }
  ],
  "kv_namespaces": [
    { "binding": "SUBS", "id": "KV_ID_AQUI" }
  ],
  "triggers": {
    "crons": ["*/15 * * * *"]
  }
}
```

Nota: route em zona tem precedência sobre custom domain do worker do site — `/api/push/*` cai neste worker, resto do site segue intocado.

- [ ] **Step 5: Criar `workers/push/.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 6: Instalar dependências**

```bash
cd workers/push && npm install
```

Expected: instala sem erro.

- [ ] **Step 7: Criar `workers/push/.dev.vars` para dev local** (NÃO commitar — já está no .gitignore; usar as chaves do Step 1)

```
VAPID_PUBLIC_KEY=<chave pública do Step 1>
VAPID_PRIVATE_KEY=<chave privada do Step 1>
ADMIN_KEY=dev-admin-key
```

- [ ] **Step 8: Commit**

```bash
git add workers/push/package.json workers/push/package-lock.json workers/push/wrangler.jsonc workers/push/.gitignore
git commit -m "feat: scaffold eduf-push worker (wrangler + KV + cron config)"
```

---

### Task 2: Código do Worker (subscribe, unsubscribe, send-test, cron)

**Files:**
- Create: `workers/push/src/index.js`

- [ ] **Step 1: Criar `workers/push/src/index.js`**

```js
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
```

- [ ] **Step 2: Subir dev server e testar validação de subscribe**

```bash
cd workers/push && npx wrangler dev --test-scheduled
```

Em outro terminal:

```bash
curl -s -X POST http://localhost:8787/api/push/subscribe -d '{"foo":"bar"}'
```

Expected: `{"error":"invalid subscription"}` (HTTP 400).

- [ ] **Step 3: Testar subscribe válido + unsubscribe**

```bash
curl -s -X POST http://localhost:8787/api/push/subscribe \
  -d '{"endpoint":"https://fcm.googleapis.com/fake/abc","keys":{"p256dh":"x","auth":"y"}}'
curl -s -X POST http://localhost:8787/api/push/unsubscribe \
  -d '{"endpoint":"https://fcm.googleapis.com/fake/abc"}'
```

Expected: `{"ok":true}` nas duas.

- [ ] **Step 4: Testar send-test sem e com admin key**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/api/push/send-test
curl -s -X POST http://localhost:8787/api/push/send-test -H "x-admin-key: dev-admin-key"
```

Expected: `403` na primeira; `{"ok":0,"removed":0,"failed":0}` na segunda (KV local vazia — subscription fake do Step 3 foi removida).

- [ ] **Step 5: Testar handler do cron**

```bash
curl -s "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

Expected: HTTP 200 (`Ran scheduled event`). No terminal do `wrangler dev`, sem exceção. (O fetch de `https://eduf.me/notify.json` retorna 404 até a Task 3 estar deployada — o código trata com `skipped`; ok.)

- [ ] **Step 6: Commit**

```bash
git add workers/push/src/index.js
git commit -m "feat: eduf-push worker — subscribe/unsubscribe, send-test, cron via notify.json"
```

---

### Task 3: `notify.json` no Eleventy

**Files:**
- Modify: `eleventy.config.js` (perto das outras collections, ~linha 250, depois de `monoestereo`)
- Create: `src/notify.njk`

- [ ] **Step 1: Adicionar collection `notifyPosts` em `eleventy.config.js`**

Logo após a collection `monoestereo` (que termina ~linha 254), adicionar:

```js
  // Posts que geram notificação push: só type "post", sem MonoEstéreo.
  // (As collections por tipo acima filtram por TAG, não pelo campo `type` —
  //  por isso aqui o filtro é por item.data.type.)
  eleventyConfig.addCollection("notifyPosts", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/posts/**/*.md")
      .filter(item => !isMonoestereo(item) && item.data.type === "post")
      .sort(newestFirst);
  });
```

- [ ] **Step 2: Criar `src/notify.njk`**

```njk
---
permalink: /notify.json
eleventyExcludeFromCollections: true
---
[
{%- for post in collections.notifyPosts | head(5) %}
  {
    "title": {{ (post.data.title or "eduf.me") | dump | safe }},
    "description": {{ (post.data.description or "") | dump | safe }},
    "url": {{ (site.url + post.url) | dump | safe }},
    "date": {{ post.date | dateToRfc3339 | dump | safe }}
  }{% if not loop.last %},{% endif %}
{%- endfor %}
]
```

(`dump` é o JSON.stringify do Nunjucks — cuida do escaping de aspas/acentos nos títulos.)

- [ ] **Step 3: Build e validar JSON**

```bash
npm run build && python3 -m json.tool _site/notify.json | head -20
```

Expected: JSON válido; itens em ordem cronológica reversa; todos com `"url": "https://eduf.me/..."`.

- [ ] **Step 4: Confirmar que só entrou `type: post`**

```bash
python3 -c "
import json
posts = json.load(open('_site/notify.json'))
print(len(posts), 'itens')
for p in posts: print(p['date'][:10], p['title'][:60])
"
```

Expected: 5 itens (ou menos), títulos de artigos — sem notas/links/quotes/episódios MonoEstéreo. Conferir manualmente contra `src/posts/`.

- [ ] **Step 5: Commit**

```bash
git add eleventy.config.js src/notify.njk
git commit -m "feat: notify.json com últimos artigos (fonte do cron de push)"
```

---

### Task 4: Service worker

**Files:**
- Create: `src/sw.js`
- Modify: `eleventy.config.js` (bloco de passthrough, ~linha 164)

- [ ] **Step 1: Criar `src/sw.js`**

```js
// Service worker do eduf.me — só push. Sem cache, sem offline, sem fetch handler.

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "eduf.me", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "eduf.me", {
      body: data.body || "",
      data: { url: data.url || "https://eduf.me/" }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

- [ ] **Step 2: Adicionar passthrough em `eleventy.config.js`**

Junto dos outros `addPassthroughCopy` (~linha 164):

```js
  eleventyConfig.addPassthroughCopy("src/sw.js");
```

- [ ] **Step 3: Build e verificar saída na raiz**

```bash
npm run build && ls -la _site/sw.js
```

Expected: `_site/sw.js` existe (raiz do site → escopo `/`).

- [ ] **Step 4: Commit**

```bash
git add src/sw.js eleventy.config.js
git commit -m "feat: service worker mínimo para push (escopo raiz)"
```

---

### Task 5: Página `/notificacoes/` + JS cliente + manifest + menu

**Files:**
- Create: `src/assets/js/push.js`
- Create: `src/notificacoes.njk`
- Create: `src/manifest.json`
- Modify: `src/_includes/layouts/base.njk` (menu ~linha 101-109; `<link rel="manifest">` no `<head>`)

- [ ] **Step 1: Criar `src/assets/js/push.js`** (substituir `COLE_A_CHAVE_PUBLICA_AQUI` pela chave pública VAPID da Task 1 — ela é pública por design, pode ser commitada)

```js
// Opt-in de notificações push — usado só em /notificacoes/.
// CSP do site exige JS externo ('self'); nada de inline.

const VAPID_PUBLIC_KEY = "COLE_A_CHAVE_PUBLICA_AQUI";

const btn = document.getElementById("push-toggle");
const status = document.getElementById("push-status");

function setStatus(text) {
  status.textContent = text;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function getSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function refreshUI() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.hidden = true;
    setStatus("Seu navegador não suporta notificações push.");
    return;
  }
  if (Notification.permission === "denied") {
    btn.hidden = true;
    setStatus("Permissão negada. Para reativar, mude a permissão de notificações deste site nas configurações do navegador.");
    return;
  }
  const sub = await getSubscription();
  btn.hidden = false;
  if (sub) {
    btn.textContent = "Desativar notificações";
    setStatus("Notificações ativadas neste navegador.");
  } else {
    btn.textContent = "Ativar notificações";
    setStatus("Notificações desativadas.");
  }
}

async function subscribe() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    await refreshUI();
    return;
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON())
  });
  if (!res.ok) {
    await sub.unsubscribe();
    throw new Error("Falha ao registrar no servidor.");
  }
}

async function unsubscribe() {
  const sub = await getSubscription();
  if (!sub) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint })
  });
  await sub.unsubscribe();
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const sub = await getSubscription();
    if (sub) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  } catch (err) {
    setStatus("Algo deu errado: " + err.message);
  } finally {
    btn.disabled = false;
    await refreshUI();
  }
});

refreshUI();
```

- [ ] **Step 2: Criar `src/notificacoes.njk`**

```njk
---
layout: layouts/base.njk
title: notificações
permalink: /notificacoes/
description: "Ative notificações no navegador para saber quando sai artigo novo no eduf.me."
---
<article class="post">
  <h1>notificações</h1>

  <p>Quer saber quando sai artigo novo por aqui? Dá pra receber uma notificação
  no navegador — só para <strong>artigos</strong> (notas, links e citações não
  notificam). Sem cadastro, sem e-mail, sem rastreamento: seu navegador fala
  direto com o servidor do site. Dá pra desativar a qualquer momento nesta
  mesma página.</p>

  <p>
    <button id="push-toggle" hidden>Ativar notificações</button>
  </p>
  <p id="push-status">Verificando…</p>

  <p><small>No iPhone/iPad (e no Safari do Mac), a Apple só permite notificações
  de sites adicionados à tela de início: toque em compartilhar →
  “Adicionar à Tela de Início” e ative por lá. Alternativa que funciona em
  qualquer lugar: o <a href="/feed.xml">feed RSS</a>.</small></p>
</article>
<script src="/assets/js/push.js" defer></script>
```

Nota pro executor: conferir como as outras páginas (`src/sobre.njk`) declaram layout/estrutura e seguir o mesmo padrão de markup se divergir deste esqueleto.

- [ ] **Step 3: Criar `src/manifest.json`** (necessário pro caminho PWA do iOS)

```json
{
  "name": "eduf.me",
  "short_name": "eduf.me",
  "start_url": "/",
  "display": "standalone"
}
```

- [ ] **Step 4: Adicionar passthrough do manifest em `eleventy.config.js`**

Junto dos outros (~linha 164):

```js
  eleventyConfig.addPassthroughCopy("src/manifest.json");
```

- [ ] **Step 5: Editar `src/_includes/layouts/base.njk`**

(a) No `<head>`, junto das outras tags `<link>`:

```html
  <link rel="manifest" href="/manifest.json">
```

(b) No menu (`ul.site-nav`, ~linha 101), adicionar depois do item `rss`:

```njk
        <li><a href="/notificacoes"
          {% if 'notificacoes' in page.url %}class="is-current"{% endif %}>notificações</a></li>
        <li><a href="/tags"
          {% if page.url == '/tags/' %}class="is-current"{% endif %}>tags</a></li>
```

(Padrão `is-current` copiado do item `sobre`. Pro item tags, comparação exata com `/tags/` para marcar só a página geral, não as páginas de tag individuais.)

- [ ] **Step 6: Verificar no dev server**

```bash
npm start
```

Abrir `http://localhost:8080/notificacoes/`:
- Menu mostra “notificações” (marcado como atual) e “tags”.
- Botão “Ativar notificações” visível, status “Notificações desativadas.”
- Console sem erro de CSP.
- Clicar “Ativar” → prompt de permissão aparece **só após o clique**. (Subscribe vai falhar com erro no fetch `/api/push/subscribe` — não existe no dev server do Eleventy. Esperado; teste completo é em produção, Task 6.)
- Abrir `http://localhost:8080/` e navegar o site: **nenhum** prompt automático em página nenhuma.
- `http://localhost:8080/tags/` → link “tags” marcado como atual.

- [ ] **Step 7: Commit**

```bash
git add src/assets/js/push.js src/notificacoes.njk src/manifest.json src/_includes/layouts/base.njk eleventy.config.js
git commit -m "feat: página /notificacoes/, JS de opt-in, manifest e links no menu"
```

---

### Task 6: Deploy + teste ponta a ponta

**Files:** nenhum novo — deploy e verificação.

- [ ] **Step 1: Configurar secrets de produção no Worker** (usar chaves da Task 1; gerar admin key nova)

```bash
cd workers/push
npx wrangler secret put VAPID_PUBLIC_KEY    # colar chave pública
npx wrangler secret put VAPID_PRIVATE_KEY   # colar chave privada
openssl rand -hex 24                        # gerar admin key; guardar
npx wrangler secret put ADMIN_KEY           # colar admin key gerada
```

Expected: `Success! Uploaded secret ...` três vezes.

- [ ] **Step 2: Deploy do Worker**

```bash
cd workers/push && npx wrangler deploy
```

Expected: deploy ok, mostrando route `eduf.me/api/push/*` e trigger cron `*/15 * * * *`.

- [ ] **Step 3: Push do site**

```bash
git push
```

Expected: Workers Builds builda e publica. Aguardar e conferir:

```bash
curl -s https://eduf.me/notify.json | python3 -m json.tool | head
curl -s -o /dev/null -w "%{http_code}\n" https://eduf.me/sw.js
```

Expected: JSON dos artigos; `200` pro sw.js.

- [ ] **Step 4: Verificar route do Worker em produção**

```bash
curl -s -X POST https://eduf.me/api/push/subscribe -d '{}' 
```

Expected: `{"error":"invalid subscription"}` — prova que `/api/push/*` cai no worker `eduf-push`, não no site.

- [ ] **Step 5: Inscrição real + notificação de teste**

1. Abrir `https://eduf.me/notificacoes/` no Chrome ou Firefox (desktop).
2. Clicar “Ativar notificações” → aceitar permissão → status “Notificações ativadas neste navegador.”
3. Disparar teste:

```bash
curl -s -X POST https://eduf.me/api/push/send-test -H "x-admin-key: <admin key do Step 1>"
```

Expected: `{"ok":1,"removed":0,"failed":0}` e notificação “Teste — eduf.me” aparece no desktop. Clicar nela → abre `https://eduf.me/`.

- [ ] **Step 6: Verificar estado inicial do cron**

Esperar próximo tick do cron (≤15 min) ou conferir logs:

```bash
cd workers/push && npx wrangler tail --format pretty
```

Expected: execução do cron sem erro. Primeira execução grava `meta:last-notified` sem enviar nada (comportamento projetado — não notifica post antigo). Confirmar:

```bash
npx wrangler kv key get --binding SUBS --remote "meta:last-notified"
```

Expected: URL do artigo mais recente.

- [ ] **Step 7: Desativar e reativar**

Na página `/notificacoes/`: clicar “Desativar notificações” → status muda; rodar send-test de novo → `{"ok":0,...}`. Reativar → `{"ok":1,...}`.

- [ ] **Step 8: Registrar admin key**

Guardar a admin key em local seguro fora do repo (ex. nota no Obsidian fora da pasta do site, ou gerenciador de senhas). Ela permite disparar notificação de teste pra todos os inscritos.

---

## Fora do escopo (registrado, não fazer)

- Corrigir o quirk das collections por tipo (`getFilteredByTag` vs `data.type`).
- Ícone PNG na notificação (favicon é SVG; Chrome ignora SVG em notificação — sai sem ícone, aceitável).
- Notificação de verdade ponta-a-ponta via cron só acontece no próximo artigo publicado — validar quando ocorrer.
