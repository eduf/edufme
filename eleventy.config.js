const sharp      = require("sharp");
const crypto     = require("crypto");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const http       = require("http");
const markdownIt = require("markdown-it");
const { slugify, resolveImagePath } = require("./lib/content");

// ─── Dithering ───────────────────────────────────────────────────────────────

const DITHER_CACHE = ".cache/dithered";
const DITHER_URL   = "/assets/images/dithered";
const DITHER_OUT   = `_site${DITHER_URL}`;
const MAX_WIDTH    = 1320; // 2× para retina; coluna de conteúdo chega a ~660 px no desktop
const GRAY_LEVELS  = 4;   // preto, cinza escuro, cinza claro, branco

function floydSteinberg(data, width, height) {
  const buf  = new Float32Array(data);
  const step = 255 / (GRAY_LEVELS - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const q = Math.round(buf[i] / step) * step;
      const e = buf[i] - q;
      buf[i] = q;
      if (x + 1 < width)        buf[i + 1]         += e * 7 / 16;
      if (y + 1 < height) {
        if (x > 0)               buf[i + width - 1] += e * 3 / 16;
                                 buf[i + width]     += e * 5 / 16;
        if (x + 1 < width)       buf[i + width + 1] += e * 1 / 16;
      }
    }
  }
  return Buffer.from(buf.map(v => Math.max(0, Math.min(255, v))));
}

// Memoização por build: home e páginas de tag repetem as mesmas imagens,
// então cada uma é processada (hash + metadata + cópia) uma única vez.
const imageJobs   = new Map(); // srcPath  → Promise<{cached, filename, width, height}>
const youtubeJobs = new Map(); // videoId  → Promise<{cached, filename, width, height}>
const copiedToSite = new Set(); // filenames já copiados para _site neste build

function copyToSite(cached, filename) {
  if (copiedToSite.has(filename)) return;
  fs.copyFileSync(cached, path.join(DITHER_OUT, filename));
  copiedToSite.add(filename);
}

function processImage(srcPath) {
  if (!imageJobs.has(srcPath)) imageJobs.set(srcPath, processImageUncached(srcPath));
  return imageJobs.get(srcPath);
}

async function processImageUncached(srcPath) {
  fs.mkdirSync(DITHER_CACHE, { recursive: true });

  const hash     = crypto.createHash("md5").update(fs.readFileSync(srcPath)).digest("hex").slice(0, 10);
  const filename = `${hash}.png`;
  const cached   = path.join(DITHER_CACHE, filename);

  if (!fs.existsSync(cached)) {
    const src    = sharp(srcPath).grayscale();
    const { data, info } = await src
      .resize(MAX_WIDTH, null, { withoutEnlargement: true, fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const dithered = floydSteinberg(data, info.width, info.height);

    await sharp(dithered, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png({ palette: true, colors: GRAY_LEVELS, compressionLevel: 9 })
      .toFile(cached);
  }

  const { width, height } = await sharp(cached).metadata();
  return { cached, filename, width, height };
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

function extractYouTubeId(str) {
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com)\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) return m[1];
  }
  return null;
}

function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error(`Redirects demais: ${url}`));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
    // Sem timeout, um host que não responde congela o build inteiro
    req.setTimeout(10000, () => req.destroy(new Error(`Timeout: ${url}`)));
  });
}

function processYouTubeThumbnail(videoId) {
  if (!youtubeJobs.has(videoId)) youtubeJobs.set(videoId, processYouTubeThumbnailUncached(videoId));
  return youtubeJobs.get(videoId);
}

async function processYouTubeThumbnailUncached(videoId) {
  fs.mkdirSync(DITHER_CACHE, { recursive: true });

  const cacheKey  = `yt-${videoId}`;
  const hash      = crypto.createHash("md5").update(cacheKey).digest("hex").slice(0, 10);
  const filename  = `${hash}.png`;
  const cached    = path.join(DITHER_CACHE, filename);

  if (!fs.existsSync(cached)) {
    // Tenta maxresdefault, cai em hqdefault se não existir
    let imgBuf;
    for (const quality of ["maxresdefault", "hqdefault"]) {
      try {
        const url = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
        imgBuf = await fetchUrl(url);
        // YouTube retorna imagem 120x90 cinza quando não existe — rejeita se muito pequena
        if (imgBuf.length > 5000) break;
      } catch {}
    }
    if (!imgBuf || imgBuf.length < 5000) throw new Error(`Thumbnail não encontrada: ${videoId}`);

    const src = sharp(imgBuf).grayscale();
    const { data, info } = await src
      .resize(MAX_WIDTH, null, { withoutEnlargement: true, fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const dithered = floydSteinberg(data, info.width, info.height);
    await sharp(dithered, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png({ palette: true, colors: GRAY_LEVELS, compressionLevel: 9 })
      .toFile(cached);
  }

  const { width, height } = await sharp(cached).metadata();
  return { cached, filename, width, height };
}

// ─── Eleventy config ──────────────────────────────────────────────────────────

module.exports = function(eleventyConfig) {

  // Markdown com linkify: URLs soltas viram links automaticamente
  const md = markdownIt({ html: true, linkify: true });
  eleventyConfig.setLibrary("md", md);

  // Copia assets estáticos
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/.well-known");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/_redirects");
  eleventyConfig.addPassthroughCopy("src/_headers");

  // Caches de imagem valem por build: limpa para que edições em imagens
  // sejam captadas nos rebuilds do --serve
  eleventyConfig.on("eleventy.before", () => {
    imageJobs.clear();
    youtubeJobs.clear();
    copiedToSite.clear();
  });

  eleventyConfig.addFilter("slugify", slugify);

  const normalizeTag = tag => slugify(tag);

  const tagLabelScore = tag => {
    const value = String(tag || "");
    let score = 0;
    if (/\s/.test(value)) score += 2;
    if (/[A-ZÀ-Ý]/.test(value)) score += 1;
    if (!/-/.test(value)) score += 1;
    return score;
  };

  const shouldReplaceTagLabel = (current, candidate) => {
    const currentScore = tagLabelScore(current);
    const candidateScore = tagLabelScore(candidate);
    if (candidateScore !== currentScore) return candidateScore > currentScore;
    return String(candidate).length > String(current).length;
  };

  const newestFirst = (a, b) => {
    const dateDiff = b.date - a.date;
    if (dateDiff !== 0) return dateDiff;
    return a.inputPath.localeCompare(b.inputPath);
  };

  // Collections por post-type
  const types = ["note", "link", "quote", "image", "video", "post"];
  types.forEach(type => {
    eleventyConfig.addCollection(type, function(collectionApi) {
      return collectionApi.getFilteredByTag(type).sort(newestFirst);
    });
  });

  // Helper: detecta posts do MonoEstéreo pelo tag
  const isMonoestereo = item => {
    const tags = item.data.tags || [];
    return tags.some(t =>
      typeof t === "string" &&
      t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("monoestereo")
    );
  };

  // Collection geral: todos os posts exceto MonoEstéreo, ordem cronológica reversa
  eleventyConfig.addCollection("feed", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/posts/**/*.md")
      .filter(item => !isMonoestereo(item))
      .sort(newestFirst);
  });

  // Guarda de permalink: o permalink vem de `title | slugify`, então dois
  // posts com o mesmo título colidiriam silenciosamente. Falha com erro claro.
  eleventyConfig.addCollection("permalinkGuard", function(collectionApi) {
    const seen = new Map();
    collectionApi.getFilteredByGlob("src/posts/**/*.md").forEach(item => {
      const slug = slugify(item.data.title || item.fileSlug);
      if (seen.has(slug)) {
        throw new Error(
          `Permalink duplicado "/${slug}/": ${seen.get(slug)} e ${item.inputPath}. ` +
          `Mude o título de um dos posts.`
        );
      }
      seen.set(slug, item.inputPath);
    });
    return [];
  });

  // Collection MonoEstéreo
  eleventyConfig.addCollection("monoestereo", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/posts/**/*.md")
      .filter(isMonoestereo)
      .sort(newestFirst);
  });

  // Páginas públicas para tags, agrupando variações por slug normalizado.
  eleventyConfig.addCollection("tagPages", function(collectionApi) {
    const ignoredTags = new Set(types);
    const reservedSlugs = new Set([
      "admin",
      "assets",
      "feed",
      "monoestereo",
      "page",
      "robots",
      "sitemap",
      "sobre"
    ]);
    const posts = collectionApi.getFilteredByGlob("src/posts/**/*.md");
    const postSlugs = new Set(
      posts.map(item => slugify(item.data.title || item.fileSlug)).filter(Boolean)
    );
    const tagMap = new Map();

    posts.forEach(item => {
      const tags = item.data.tags || [];
      tags.forEach(tag => {
        if (typeof tag !== "string") return;
        const slug = normalizeTag(tag);
        if (!slug || ignoredTags.has(slug) || reservedSlugs.has(slug)) return;

        if (!tagMap.has(slug)) {
          tagMap.set(slug, {
            slug,
            label: tag,
            url: postSlugs.has(slug) ? `/tag/${slug}/` : `/${slug}/`,
            posts: [],
            seenUrls: new Set()
          });
        } else if (shouldReplaceTagLabel(tagMap.get(slug).label, tag)) {
          tagMap.get(slug).label = tag;
        }

        const tagPage = tagMap.get(slug);
        const itemKey = item.url || item.inputPath;
        if (!tagPage.seenUrls.has(itemKey)) {
          tagPage.seenUrls.add(itemKey);
          tagPage.posts.push(item);
        }
      });
    });

    return [...tagMap.values()]
      .map(tagPage => ({
        slug: tagPage.slug,
        label: tagPage.label,
        url: tagPage.url,
        posts: tagPage.posts.sort((a, b) => b.date - a.date)
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });

  // Filtro para limitar itens de uma collection
  eleventyConfig.addFilter("head", (array, n) => {
    if (!Array.isArray(array) || array.length === 0) return [];
    return array.slice(0, n);
  });

  // Filtro de data legível
  eleventyConfig.addFilter("dateReadable", (date) => {
    return new Date(date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "America/Sao_Paulo"
    });
  });

  // Filtro de data ISO (datetime attribute)
  eleventyConfig.addFilter("dateISO", (date) => {
    return new Date(date).toISOString();
  });

  // Filtros RSS (sem plugin externo)
  eleventyConfig.addFilter("dateToRfc3339", (date) => {
    return new Date(date).toISOString();
  });

  eleventyConfig.addFilter("getNewestCollectionItemDate", (collection) => {
    if (!collection || !collection.length) return new Date();
    return new Date(Math.max(...collection.map(item => new Date(item.date))));
  });

  eleventyConfig.addFilter("htmlToAbsoluteUrls", (html, base) => {
    if (!html) return "";
    return html
      .replace(/href="\/(?!\/)/g, `href="${base}/`)
      .replace(/src="\/(?!\/)/g, `src="${base}/`);
  });

  eleventyConfig.addFilter("markdownInline", value => {
    if (!value) return "";
    return md.renderInline(String(value));
  });

  // Fallback de og:image: primeira imagem local do corpo do post
  eleventyConfig.addFilter("firstImageUrl", (rawInput, inputPath) => {
    if (!rawInput) return "";
    const match = String(rawInput).match(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/);
    if (!match || /^https?:/i.test(match[1])) return "";
    const found = resolveImagePath(match[1], inputPath);
    if (!found) return "";
    const relative = path.relative("src", found).split(path.sep).join("/");
    if (relative.startsWith("..")) return "";
    return `/${relative}`;
  });

  eleventyConfig.addFilter("tagPagesForTags", (tags, tagPages) => {
    if (!Array.isArray(tags) || !Array.isArray(tagPages)) return [];
    const pagesBySlug = new Map(tagPages.map(tagPage => [tagPage.slug, tagPage]));
    const seen = new Set();

    return tags
      .map(tag => pagesBySlug.get(slugify(tag)))
      .filter(tagPage => {
        if (!tagPage || seen.has(tagPage.slug)) return false;
        seen.add(tagPage.slug);
        return true;
      });
  });

  // ─── Transform: dithering de imagens locais ───────────────────────────────
  eleventyConfig.addTransform("dither-images", async function(content) {
    if (!this.page?.outputPath?.endsWith(".html")) return content;

    const imgRe = /(<img\b[^>]*?\bsrc=(["']))((?!https?:|\/\/|data:)[^"']+)(\2[^>]*?>)/g;

    const srcs = [];
    let m;
    while ((m = imgRe.exec(content)) !== null) srcs.push(m[3]);
    if (!srcs.length) return content;

    fs.mkdirSync(DITHER_OUT, { recursive: true });

    const map = new Map();
    await Promise.all([...new Set(srcs)].map(async src => {
      const absPath = resolveImagePath(src, this.page.inputPath);
      if (!absPath) return;
      try {
        const { cached, filename, width, height } = await processImage(absPath);
        copyToSite(cached, filename);
        map.set(src, { url: `${DITHER_URL}/${filename}`, width, height });
      } catch (e) {
        console.warn(`[dither] erro ao processar ${absPath}: ${e.message}`);
      }
    }));

    let out = content.replace(imgRe, (_, prefix, q, src, suffix) => {
      const hit = map.get(src);
      if (!hit) return _;
      // Injeta width/height para reservar espaço e evitar CLS (a menos que já existam)
      const dims = /\b(width|height)=/.test(prefix + suffix)
        ? ""
        : ` width="${hit.width}" height="${hit.height}"`;
      return `${prefix}${hit.url}${suffix.replace(/\s*\/?>$/, `${dims}$&`)}`;
    });

    // A primeira imagem do conteúdo costuma ser o elemento de LCP: promove-a a
    // alta prioridade e injeta um preload no <head> para o navegador buscá-la cedo.
    const firstImg = out.match(/<img\b[^>]*\bsrc="(\/assets\/images\/dithered\/[^"]+)"[^>]*>/);
    if (firstImg && !/\bfetchpriority=/.test(firstImg[0])) {
      const promoted = firstImg[0].replace(/<img\b/, '<img fetchpriority="high" decoding="async"');
      out = out.replace(firstImg[0], promoted);
      const preload = `<link rel="preload" as="image" href="${firstImg[1]}" fetchpriority="high">`;
      out = out.replace("</head>", `  ${preload}\n</head>`);
    }

    return out;
  });

  // ─── Transform: YouTube → thumbnail dithered ─────────────────────────────
  eleventyConfig.addTransform("youtube-thumbnails", async function(content) {
    if (!this.page?.outputPath?.endsWith(".html")) return content;

    // Detecta iframes do YouTube e links onde o texto visível É a própria URL
    // (evita substituir links com texto customizado como "Assista aqui" ou "Cartoonist Keyfabe")
    const iframeRe = /<iframe\b[^>]*\bsrc=(["'])((?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed[^"']*)\1[^>]*>(?:<\/iframe>)?/gi;
    const linkRe   = /<a\b[^>]*\bhref=(["'])((?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch|youtu\.be)[^"']*)\1[^>]*>(https?:\/\/[^<]+)<\/a>/gi;

    const jobs = new Map(); // videoId → watchUrl

    for (const re of [iframeRe, linkRe]) {
      let m;
      while ((m = re.exec(content)) !== null) {
        const url = m[2];
        const id  = extractYouTubeId(url);
        if (!id || jobs.has(id)) continue;
        const watchUrl = `https://www.youtube.com/watch?v=${id}`;
        jobs.set(id, watchUrl);
      }
    }

    if (!jobs.size) return content;

    fs.mkdirSync(DITHER_OUT, { recursive: true });

    const results = new Map(); // videoId → { imgSrc, watchUrl }
    await Promise.all([...jobs.entries()].map(async ([id, watchUrl]) => {
      try {
        const { cached, filename, width, height } = await processYouTubeThumbnail(id);
        copyToSite(cached, filename);
        results.set(id, { imgSrc: `${DITHER_URL}/${filename}`, watchUrl, width, height });
      } catch (e) {
        console.warn(`[youtube] erro no vídeo ${id}: ${e.message}`);
      }
    }));

    const replacement = (url) => {
      const id = extractYouTubeId(url);
      if (!id || !results.has(id)) return null;
      const { imgSrc, watchUrl, width, height } = results.get(id);
      return `<a href="${watchUrl}" class="youtube-thumb" target="_blank" rel="noopener">`
           + `<img src="${imgSrc}" alt="Ver vídeo no YouTube" width="${width}" height="${height}"></a>`;
    };

    content = content.replace(iframeRe, (full, q, url) => replacement(url) || full);
    content = content.replace(linkRe,   (full, q, url) => replacement(url) || full);

    return content;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      layouts: "_includes/layouts"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};
