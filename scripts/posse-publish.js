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

  return {
    filePath,
    url,
    absoluteUrl,
    title: data.title || fileSlug,
    description: data.description || "",
    date
  };
}

function getEnabledPlatforms() {
  const platforms = [];
  if (process.env.MASTODON_INSTANCE && process.env.MASTODON_ACCESS_TOKEN) {
    platforms.push("mastodon");
  }
  if (process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD) {
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

function buildStatus(post) {
  const parts = [post.title];
  if (post.description) parts.push(post.description);
  parts.push(post.absoluteUrl);
  return truncate(parts.join("\n\n"), 500);
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function normalizeUrl(value) {
  if (!value) return "";
  let trimmed = value
    .trim()
    .replace(/^[A-Z0-9_]+\s*=\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/\/+$/, "");
  const match = trimmed.match(/https?:\/\/[^\s`"'<>]+|[a-z0-9.-]+\.[a-z]{2,}/i);
  if (match) trimmed = match[0].replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function publishMastodon(post, status, dryRun) {
  const instance = normalizeUrl(process.env.MASTODON_INSTANCE);
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!instance || !token) return null;

  if (dryRun) {
    return {
      id: "dry-run",
      url: new URL(`/@dry-run/${slugify(post.title)}`, instance).toString()
    };
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
      visibility: process.env.MASTODON_VISIBILITY || "public"
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Mastodon failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return { id: body.id, url: body.url || body.uri };
}

function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function buildBlueskyFacets(text, url) {
  const start = text.indexOf(url);
  if (start === -1) return [];

  return [{
    index: {
      byteStart: utf8ByteLength(text.slice(0, start)),
      byteEnd: utf8ByteLength(text.slice(0, start + url.length))
    },
    features: [{
      $type: "app.bsky.richtext.facet#link",
      uri: url
    }]
  }];
}

async function publishBluesky(post, status, dryRun) {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return null;

  if (dryRun) {
    return {
      uri: "at://did:plc:dry-run/app.bsky.feed.post/dry-run",
      cid: "dry-run",
      url: `https://bsky.app/profile/${identifier}/post/dry-run`
    };
  }

  const service = normalizeUrl(process.env.BLUESKY_SERVICE || "https://bsky.social");
  const sessionResponse = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok) {
    throw new Error(`Bluesky login failed (${sessionResponse.status}): ${JSON.stringify(session)}`);
  }

  const record = {
    $type: "app.bsky.feed.post",
    text: status,
    createdAt: new Date().toISOString(),
    facets: buildBlueskyFacets(status, post.absoluteUrl),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: post.absoluteUrl,
        title: post.title,
        description: post.description || "Novo texto em eduf.me"
      }
    }
  };

  const createResponse = await fetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
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
    throw new Error(`Bluesky publish failed (${createResponse.status}): ${JSON.stringify(created)}`);
  }

  const rkey = created.uri.split("/").pop();
  return {
    uri: created.uri,
    cid: created.cid,
    url: `https://bsky.app/profile/${identifier}/post/${rkey}`
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

  for (const file of files) {
    const post = loadPost(file, site.url);
    const record = state[post.url] || {};
    const decision = shouldPublish(post, record, platforms, args);
    if (!decision.ok) {
      console.log(`Skipping ${path.relative(ROOT, file)}: ${decision.reason}.`);
      continue;
    }

    const status = buildStatus(post);
    console.log(`${args.dryRun ? "Would publish" : "Publishing"} ${post.absoluteUrl}`);

    const mastodon = record.mastodonUrl ? null : await publishMastodon(post, status, args.dryRun);
    if (mastodon) {
      record.mastodonId = mastodon.id;
      record.mastodonUrl = mastodon.url;
      changed = true;
      console.log(`  Mastodon: ${mastodon.url}`);
    }

    const bluesky = record.blueskyUrl ? null : await publishBluesky(post, status, args.dryRun);
    if (bluesky) {
      record.blueskyUri = bluesky.uri;
      record.blueskyCid = bluesky.cid;
      record.blueskyUrl = bluesky.url;
      changed = true;
      console.log(`  Bluesky: ${bluesky.url}`);
    }

    record.publishedAt = args.dryRun ? "dry-run" : new Date().toISOString();
    state[post.url] = record;
  }

  if (changed && !args.dryRun) {
    writeJson(STATE_PATH, state);
  } else if (args.dryRun) {
    console.log("Dry run complete. State file was not changed.");
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
