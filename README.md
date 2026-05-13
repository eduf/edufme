# eduf.me

Blog pessoal de Eduardo Fernandes — tecnologia e cultura.

## Stack

- [11ty](https://www.11ty.dev/) — gerador de site estático
- [iA Writer Duo](https://github.com/iaolo/iA-Fonts) — tipografia
- [Cloudflare Pages](https://pages.cloudflare.com/) — hospedagem

## Desenvolvimento local

```bash
npm install
npm start
```

Acesse em `http://localhost:8080`.

## Deploy (Cloudflare Pages)

Configurações no dashboard do Cloudflare Pages:

| Campo | Valor |
|---|---|
| Build command | `npm run build` |
| Build output directory | `_site` |
| Node version | `20` |

## Post-types

Cada post em `src/posts/` tem um frontmatter com `type`:

| Type | Uso |
|---|---|
| `note` | Nota curta, sem título |
| `link` | Link externo com comentário |
| `quote` | Citação com fonte |
| `image` | Imagem com legenda |
| `post` | Texto longo com título e permalink |

## Fluxo de publicação

Obsidian (escreve em Markdown) → Obsidian Git (commit + push) → Cloudflare Pages (build automático)

## Fontes

Baixe a iA Writer Duo em https://github.com/iaolo/iA-Fonts e coloque os arquivos `.woff2` em `src/assets/fonts/`:

- `iAWriterDuoS-Regular.woff2`
- `iAWriterDuoS-Italic.woff2`
- `iAWriterDuoS-Bold.woff2`
