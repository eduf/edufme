#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, "src/posts");
const STATE_PATH = path.join(ROOT, "src/_data/posse.json");
const SITE_DATA_PATH = path.join(ROOT, "src/_data/site.json");
const DEFAULT_MAX_AGE_DAYS = 14;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    maxAgeDays: Number(process.env.POSSE_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS),
    files: []
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--max-age-days") args.maxAgeDays = Number(argv[++i]);
    else if (arg === "--file") args.files.push(argv[++i]);
    else if (arg === "--all") args.all = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    else args.files.push(arg);
  }

  const envFiles = process.env.POSSE_CHANGED_FILES || "";
  envFiles
    .split(/\r?\n|,/)
    .map(file => file.trim())
    .filter(Boolean)
    .forEach(file => args.files.push(file));

  return args;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function slugify(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function extractBody(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function stripMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstParagraph(body) {
  const blocks = stripMarkdown(body).split(/\n\s*\n/);
  const prose = blocks.find(block => {
    const trimmed = block.trim();
    if (!trimmed) return false;
    // Pula embeds/shortcodes/HTML e blocos que são só URL
    if (/^[\\[<]/.test(trimmed)) return false;
    if (/^https?:\/\/\S+$/.test(trimmed)) return false;
    return /[a-zA-ZÀ-ÿ]/.test(trimmed);
  });
  return (prose || "").trim().replace(/\s+/g, " ");
}

function findFirstImage(body) {
  const match = body.match(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/);
  if (!match) return null;
  return { alt: match[1].trim(), src: match[2] };
}

function findInSrc(basename, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findInSrc(basename, full);
      if (found) return found;
    } else if (entry.name === basename) {
      return full;
    }
  }
  return null;
}

// Espelha a resolução de imagens do eleventy.config.js
function resolveImagePath(src, inputPath) {
  const decoded = decodeURIComponent(src);
  const basename = path.basename(decoded);
  const candidates = [
    path.join(path.dirname(inputPath), decoded),
    path.join(ROOT, "src", decoded.replace(/^\//, "")),
    path.join(ROOT, "src/assets/images", basename)
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (found) return found;
  return findInSrc(basename, path.join(ROOT, "src"));
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};

  const data = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pair = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!pair) continue;

    const key = pair[1];
    const rawValue = pair[2] || "";

    if (rawValue.trim() === "") {
      const values = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const item = next.match(/^\s+-\s+(.+)$/);
        if (!item) break;
        values.push(parseScalar(item[1]));
        i++;
      }
      data[key] = values.length ? values : "";
    } else if (rawValue.trim().startsWith("[") && rawValue.trim().endsWith("]")) {
      data[key] = rawValue
        .trim()
        .slice(1, -1)
        .split(",")
        .map(parseScalar)
        .filter(Boolean);
    } else {
      data[key] = parseScalar(rawValue);
    }
  }

  return data;
}

function getPostFiles(args) {
  if (args.all) return walkMarkdown(POSTS_DIR);

  const files = [...new Set(args.files)]
    .filter(file => file.startsWith("src/posts/") && file.endsWith(".md"))
    .map(file => path.join(ROOT, file))
    .filter(file => fs.existsSync(file));

  return files;
}

function walkMarkdown(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

function loadPost(filePath, siteUrl) {
  const markdown = fs.readFileSync(filePath, "utf8");
  const data = parseFrontmatter(markdown);
  const fileSlug = slugify(path.basename(filePath, ".md"));
  const slug = slugify(data.title || fileSlug);
  const url = `/${slug}/`;
  const absoluteUrl = new URL(url, siteUrl).toString();
  const date = data.date ? new Date(data.date) : null;
  const body = extractBody(markdown);
  const rawImage = findFirstImage(body);
  let image = null;
  if (rawImage && !/^https?:/i.test(rawImage.src)) {
    const imagePath = resolveImagePath(rawImage.src, filePath);
    if (imagePath) image = { alt: rawImage.alt, path: imagePath };
  }

  return {
    filePath,
    url,
    absoluteUrl,
    type: data.type || "post",
    title: data.title || fileSlug,
    description: data.description || "",
    date,
    body,
    plainBody: stripMarkdown(body),
    image
  };
}

function getEnabledPlatforms() {
  const platforms = [];
  if (process.env.MASTODON_INSTANCE && process.env.MASTODON_ACCESS_TOKEN) {
    platforms.push("mastodon");
  }
  if (getBlueskyIdentifier() && getBlueskyPassword()) {
    platforms.push("bluesky");
  }
  return platforms;
}

function hasAllEnabledPlatforms(record, platforms) {
  if (!platforms.length) return false;
  return platforms.every(platform => {
    if (platform === "mastodon") return Boolean(record?.mastodonUrl);
    if (platform === "bluesky") return Boolean(record?.blueskyUrl);
    return false;
  });
}

function shouldPublish(post, record, platforms, args) {
  if (hasAllEnabledPlatforms(record, platforms)) {
    return { ok: false, reason: "already recorded" };
  }

  if (!post.date || Number.isNaN(post.date.getTime())) {
    return { ok: false, reason: "missing or invalid date" };
  }

  const now = new Date();
  if (post.date > now) return { ok: false, reason: "future dated" };

  if (!args.force) {
    const ageMs = now - post.date;
    const maxAgeMs = args.maxAgeDays * 24 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      return { ok: false, reason: `older than ${args.maxAgeDays} days` };
    }
  }

  return { ok: true };
}

// Mastodon conta qualquer URL como 23 caracteres
function mastodonLength(text) {
  return text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
}

function graphemes(text) {
  return [...new Intl.Segmenter().segment(text)].map(segment => segment.segment);
}

function truncateGraphemes(text, max) {
  const segments = graphemes(text);
  if (segments.length <= max) return text;
  return `${segments.slice(0, max - 1).join("").trimEnd()}…`;
}

function truncateChars(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function buildStatus(post, platform) {
  const bluesky = platform === "bluesky";
  const limit = bluesky ? 300 : 500;
  const truncate = bluesky ? truncateGraphemes : truncateChars;
  const url = post.absoluteUrl;
  const urlCost = bluesky ? graphemes(url).length : 23;

  if (post.type === "note") {
    const budget = limit - urlCost - 2;
    if (!post.plainBody) return url;
    return `${truncate(post.plainBody, budget)}\n\n${url}`;
  }

  if (post.type === "image") {
    return post.image && post.image.alt ? `${post.image.alt}\n\n${url}` : url;
  }

  const summary = post.description || firstParagraph(post.body);
  const titleCost = bluesky ? graphemes(post.title).length : post.title.length;
  const budget = limit - titleCost - urlCost - 4;
  const parts = [post.title];
  if (summary && budget > 20) parts.push(truncate(summary, budget));
  parts.push(url);
  return parts.join("\n\n");
}

function stripEnvAssignment(value) {
  if (!value) return "";
  return value
    .trim()
    .replace(/^[A-Z0-9_]+\s*=\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function normalizeUrl(value) {
  if (!value) return "";
  let trimmed = stripEnvAssignment(value)
    .trim()
    .replace(/\/+$/, "");
  const match = trimmed.match(/https?:\/\/[^\s`"'<>]+|[a-z0-9.-]+\.[a-z]{2,}/i);
  if (match) trimmed = match[0].replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function normalizeBlueskyIdentifier(value) {
  return stripEnvAssignment(value).replace(/^@/, "");
}

function getBlueskyIdentifier() {
  return normalizeBlueskyIdentifier(
    process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE || process.env.BLUESKY_ID
  );
}

function getBlueskyPassword() {
  return stripEnvAssignment(process.env.BLUESKY_APP_PASSWORD || process.env.BLUESKY_PASSWORD);
}

function buildLinkFacet(text, url) {
  const index = text.indexOf(url);
  if (index === -1) return [];

  return [{
    index: {
      byteStart: Buffer.byteLength(text.slice(0, index), "utf8"),
      byteEnd: Buffer.byteLength(text.slice(0, index + url.length), "utf8")
    },
    features: [{
      $type: "app.bsky.richtext.facet#link",
      uri: url
    }]
  }];
}

// Bluesky limita blobs a ~976KB; mesma imagem serve para o Mastodon
const MAX_IMAGE_BYTES = 950000;

async function prepareImage(image) {
  const sharp = require("sharp");
  let quality = 85;
  let buffer = await sharp(image.path)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();

  while (buffer.length > MAX_IMAGE_BYTES && quality > 40) {
    quality -= 15;
    buffer = await sharp(image.path)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  }

  const meta = await sharp(buffer).metadata();
  return { buffer, mime: "image/jpeg", width: meta.width, height: meta.height, alt: image.alt || "" };
}

async function uploadMastodonMedia(instance, token, media) {
  const form = new FormData();
  form.append("file", new Blob([media.buffer], { type: media.mime }), "image.jpg");
  if (media.alt) form.append("description", media.alt);

  const response = await fetch(new URL("/api/v2/media", instance), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Mastodon media failed (${response.status}): ${JSON.stringify(body)}`);
  }
  // 202 = ainda processando; espera antes de anexar ao status
  if (response.status === 202) await new Promise(resolve => setTimeout(resolve, 2000));
  return body.id;
}

async function publishMastodon(post, status, media, dryRun) {
  const instance = normalizeUrl(process.env.MASTODON_INSTANCE);
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!instance || !token) return null;

  if (dryRun) {
    return {
      id: "dry-run",
      url: new URL(`/@dry-run/${slugify(post.title)}`, instance).toString()
    };
  }

  const mediaIds = [];
  if (post.type === "image" && media) {
    mediaIds.push(await uploadMastodonMedia(instance, token, media));
  }

  const endpoint = new URL("/api/v1/statuses", instance);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `edufme:${post.url}`
    },
    body: JSON.stringify({
      status,
      visibility: process.env.MASTODON_VISIBILITY || "public",
      ...(mediaIds.length ? { media_ids: mediaIds } : {})
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Mastodon failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return { id: body.id, url: body.url || body.uri };
}

async function uploadBlueskyBlob(session, media) {
  const response = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": media.mime
    },
    body: media.buffer
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Bluesky blob failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.blob;
}

function buildBlueskyEmbed(post, blob, media) {
  if (post.type === "image" && blob) {
    return {
      $type: "app.bsky.embed.images",
      images: [{
        image: blob,
        alt: media.alt,
        aspectRatio: { width: media.width, height: media.height }
      }]
    };
  }

  // Nota vai inteira no texto; sem card
  if (post.type === "note" || post.type === "image") return undefined;

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: post.absoluteUrl,
      title: post.title,
      description: truncateGraphemes(post.description || firstParagraph(post.body), 300),
      ...(blob ? { thumb: blob } : {})
    }
  };
}

async function publishBluesky(post, media, dryRun) {
  const identifier = getBlueskyIdentifier();
  const password = getBlueskyPassword();
  if (!identifier || !password) return null;

  if (dryRun) {
    return {
      uri: `at://dry-run/app.bsky.feed.post/${slugify(post.title)}`,
      url: `https://bsky.app/profile/${identifier}/post/${slugify(post.title)}`
    };
  }

  const sessionResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok) {
    throw new Error(`Bluesky login failed (${sessionResponse.status}): ${JSON.stringify(session)}`);
  }

  const blob = media && post.type !== "note"
    ? await uploadBlueskyBlob(session, media)
    : null;

  const text = buildStatus(post, "bluesky");
  const embed = buildBlueskyEmbed(post, blob, media);
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    facets: buildLinkFacet(text, post.absoluteUrl),
    ...(embed ? { embed } : {})
  };

  const createResponse = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record
    })
  });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) {
    throw new Error(`Bluesky post failed (${createResponse.status}): ${JSON.stringify(created)}`);
  }

  const rkey = created.uri.split("/").pop();
  const handle = session.handle || identifier;
  return {
    uri: created.uri,
    cid: created.cid,
    url: `https://bsky.app/profile/${handle}/post/${rkey}`
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = readJson(SITE_DATA_PATH, {});
  const state = readJson(STATE_PATH, {});
  const files = getPostFiles(args);
  const platforms = getEnabledPlatforms();

  if (!files.length) {
    console.log("No changed posts to publish.");
    return;
  }

  if (!platforms.length) {
    console.log("No social credentials configured.");
    return;
  }

  let changed = false;
  const errors = [];

  for (const file of files) {
    const post = loadPost(file, site.url);
    const record = state[post.url] || {};
    const decision = shouldPublish(post, record, platforms, args);
    if (!decision.ok) {
      console.log(`Skipping ${path.relative(ROOT, file)}: ${decision.reason}.`);
      continue;
    }

    const status = buildStatus(post, "mastodon");
    console.log(`${args.dryRun ? "Would publish" : "Publishing"} ${post.absoluteUrl} (${post.type})`);
    if (args.dryRun) {
      console.log(`  Mastodon status:\n    ${status.split("\n").join("\n    ")}`);
      console.log(`  Bluesky status:\n    ${buildStatus(post, "bluesky").split("\n").join("\n    ")}`);
      if (post.image) console.log(`  Image: ${path.relative(ROOT, post.image.path)}`);
    }

    let media = null;
    if (post.image && post.type !== "note" && !args.dryRun) {
      try {
        media = await prepareImage(post.image);
      } catch (error) {
        console.error(`  Image error: ${error.message}`);
      }
    }

    if (!record.mastodonUrl) {
      try {
        const mastodon = await publishMastodon(post, status, media, args.dryRun);
        if (mastodon) {
          record.mastodonId = mastodon.id;
          record.mastodonUrl = mastodon.url;
          changed = true;
          console.log(`  Mastodon: ${mastodon.url}`);
        }
      } catch (error) {
        errors.push(error);
        console.error(`  Mastodon error: ${error.message}`);
      }
    }

    if (!record.blueskyUrl) {
      try {
        const bluesky = await publishBluesky(post, media, args.dryRun);
        if (bluesky) {
          record.blueskyUri = bluesky.uri;
          record.blueskyCid = bluesky.cid;
          record.blueskyUrl = bluesky.url;
          changed = true;
          console.log(`  Bluesky: ${bluesky.url}`);
        }
      } catch (error) {
        errors.push(error);
        console.error(`  Bluesky error: ${error.message}`);
      }
    }

    if (record.mastodonUrl || record.blueskyUrl) {
      record.publishedAt = args.dryRun ? "dry-run" : new Date().toISOString();
      state[post.url] = record;
    }
  }

  if (changed && !args.dryRun) {
    writeJson(STATE_PATH, state);
  } else if (args.dryRun) {
    console.log("Dry run complete. State file was not changed.");
  }

  if (errors.length) {
    throw new Error(errors.map(error => error.message).join("\n"));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
