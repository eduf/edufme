# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # dev server with live reload (http://localhost:8080)
npm run build    # production build → _site/
```

The site deploys automatically to Cloudflare Pages on every push to the `main` branch.

## Architecture

**Stack**: Eleventy 3.x (Nunjucks templates) + custom `sharp`-based image pipeline. No CSS framework, no JS bundler — all CSS is hand-written in `src/assets/css/main.css` and served as-is.

### Directory layout

```
eleventy.config.js      ← all Eleventy config, filters, transforms, and the dithering pipeline
src/
  _data/site.json       ← global site metadata (url, name, author, description)
  _includes/layouts/
    base.njk            ← shell: head, sidebar nav, theme switcher, hamburger JS
    post.njk            ← individual post wrapper (extends base.njk)
    feed-item.njk       ← used by feed.njk for RSS rendering
  assets/
    css/main.css        ← all styles; theme tokens as CSS custom properties
    fonts/              ← iA Writer Duo S (static, not variable) woff2 files
    favicon.svg
  posts/                ← all content as Markdown with YAML frontmatter
  feed.njk              ← RSS feed (uses CDATA to allow raw HTML)
  sitemap.njk           ← XML sitemap
  index.njk             ← homepage
  monoestereo.njk       ← MonoEstéreo podcast archive
  sobre.njk             ← about page
  robots.txt
```

### Content model

Posts live in `src/posts/*.md` with frontmatter:

```yaml
type: post          # post | note | link | quote | image
date: 2025-01-15
tags: [tag1, tag2]
title: "…"
description: "…"   # used for <meta description> and OG/JSON-LD
```

- **type** controls which `post.njk` branch renders (quote wraps in `<blockquote>`, link shows external URL, etc.)
- Posts tagged `monoestereo` (accent-insensitive) go into the `monoestereo` collection; all other posts go into `feed`.
- Collections are defined in `eleventy.config.js`: `feed`, `monoestereo`, and per-type collections (`note`, `link`, `quote`, `image`, `post`).

### Theming

Five themes, selected via `<select id="theme-select">` in the sidebar:

| Value | Name |
|---|---|
| `gruvbox-light` | default / `:root` |
| `gruvbox-dark` | dark |
| `dracula` | Dracula |
| `solarized` | Solarized Dark |
| `claude-code` | Claude Code |

Themes work via CSS custom properties on `[data-theme]` on `<html>`. An anti-FOUC inline script in `<head>` reads `localStorage('eduf-theme')` and sets the attribute before first paint. `@media (prefers-color-scheme: dark)` applies gruvbox-dark values only when no `data-theme` attribute is set.

### Image dithering pipeline (`eleventy.config.js`)

Every HTML output file is post-processed by two transforms:

1. **`dither-images`** — replaces `<img src="…">` for local images with Floyd-Steinberg dithered 4-grey-level PNGs. Images are cached by MD5 in `.cache/dithered/` and copied to `_site/assets/images/dithered/`.
2. **`youtube-thumbnails`** — replaces YouTube `<iframe>` embeds and bare auto-linked YouTube URLs (`<a href="…">https://…</a>`) with dithered thumbnails linked to the video. Works with `youtube.com/watch`, `youtu.be`, and `youtube-nocookie.com/embed` URLs.

`linkify: true` is set on the markdown-it instance, so bare URLs in Markdown become `<a>` tags and are then caught by the YouTube transform.

Image resolution: files are resolved relative to the source file, then from `src/`, then by recursive filename search under `src/`.

### Key CSS patterns

- Layout is CSS Grid: `.tui-frame` (full viewport) → `.tui-layout` (sidebar + main).
- Sidebar is hidden on mobile (`display: none`) and shown via `.is-open` class toggled by the hamburger button (`.nav-toggle`).
- Fonts: `iA Writer Duo S` (static woff2 variants — Regular, Italic, Bold). Do **not** use the variable (`V`) variants; they cause Firefox glyph-depth warnings.
