# Notificações push no navegador — eduf.me

**Data:** 2026-07-09
**Status:** aprovado (design), aguardando plano de implementação

## Objetivo

Permitir que leitores ativem notificações de navegador para novos artigos, via página dedicada de opt-in. Nunca exibir prompt de permissão automaticamente — a permissão só é pedida após clique explícito do leitor.

## Decisões

| Decisão | Escolha |
|---|---|
| Backend | Próprio: Worker Cloudflare + KV + VAPID (sem terceiros, sem tracking) |
| Escopo de notificação | Somente `type: post` (artigos); notas, links, quotes, imagens e MonoEstéreo não notificam |
| Gatilho de envio | Cron trigger no Worker (a cada 15 min) lendo um JSON gerado pelo Eleventy |
| Menu | Item "notificações" na sidebar; aproveitar edição para incluir também link "tags" → `/tags/` |

## Arquitetura

Quatro peças:

### 1. Worker `eduf-push` (novo, separado)

Worker independente do worker do site (Workers Builds intocado), com route `eduf.me/api/push/*` no domínio.

- `POST /api/push/subscribe` — recebe a `PushSubscription` (JSON) e salva em KV. Chave = hash SHA-256 do endpoint da subscription (idempotente: re-inscrição sobrescreve).
- `POST /api/push/unsubscribe` — remove a subscription da KV.
- **Cron (a cada 15 min):**
  1. Busca `https://eduf.me/notify.json`.
  2. Compara o identificador (URL) do item mais recente com o último valor registrado em KV (`last-notified`).
  3. Se houver item novo, envia push para cada subscription na KV usando o Web Push Protocol com assinatura VAPID.
  4. Atualiza `last-notified`.
  5. Respostas `404`/`410` (subscription morta) → remove a entrada da KV.
- Endpoint de dry-run protegido (secret via header) para testar o fluxo de envio sem esperar o cron.

**Segredos:** par de chaves VAPID gerado uma vez. Chave privada como secret do Worker; chave pública embutida na página de opt-in.

### 2. `notify.json` (template Eleventy novo)

Arquivo JSON gerado no build listando apenas posts `type: post`, mais recentes primeiro, com: título, descrição, URL absoluta, data. O cron consome este arquivo em vez do `feed.xml` (o RSS mistura todos os tipos; filtrar lá seria frágil).

### 3. `sw.js` (service worker)

Servido na raiz do site (escopo `/`). Mínimo:

- Evento `push` → `showNotification(título, { body: descrição, data: { url } })`.
- Evento `notificationclick` → fecha a notificação e abre a URL do post.
- Sem cache, sem offline, sem interceptação de fetch — só push.

### 4. Página `/notificacoes/`

Página estática (template Eleventy) que:

- Explica o que são as notificações (só artigos novos, sem tracking, cancelável a qualquer momento).
- Botão "Ativar notificações": clique → `Notification.requestPermission()` → registra `sw.js` → `pushManager.subscribe()` com a chave pública VAPID → `POST /api/push/subscribe`.
- Botão de desativar quando já inscrito (unsubscribe local + `POST /api/push/unsubscribe`).
- Estado visível na página: ativado / desativado / navegador não suporta / permissão negada.
- Aviso para Safari/iOS: push só funciona com o site adicionado à tela de início (PWA) — limitação da Apple, sem contorno.

### Menu (base.njk)

Dois itens novos na `ul.site-nav`:

- `notificações` → `/notificacoes` (com marcação `is-current` seguindo o padrão existente)
- `tags` → `/tags/`

## Conteúdo da notificação

Título do post como título; descrição do frontmatter como corpo; clique abre a URL do post.

## Custo

Zero. Free tier de Workers + KV é ordens de magnitude acima do necessário para um blog pessoal.

## Riscos e limitações conhecidos

- **Safari/iOS:** exige instalação como PWA para receber push. A página de opt-in avisa. Pode exigir um `manifest.json` mínimo — verificar na implementação.
- **Criptografia no Worker:** o envio Web Push (VAPID + payload encryption RFC 8291) precisa de lib compatível com Workers (WebCrypto, sem Node crypto completo). Candidatas: `webpush-webcrypto` ou implementação direta. Validar na implementação.
- **Latência de até 15 min** entre publicação e notificação — irrelevante para blog.

## Verificação / critérios de sucesso

1. Build gera `notify.json` válido contendo apenas `type: post`.
2. Página `/notificacoes/` ativa e desativa inscrição num navegador real (Chrome ou Firefox), com estados corretos.
3. Dry-run do cron envia notificação de teste que chega ao navegador inscrito e abre o post correto ao clicar.
4. Nenhuma página do site pede permissão de notificação sem clique no botão da página de opt-in.
5. Subscription morta é removida da KV após envio com resposta 410.
