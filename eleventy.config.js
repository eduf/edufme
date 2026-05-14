const sharp = require("sharp");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// ─── Dithering ───────────────────────────────────────────────────────────────

const DITHER_CACHE = ".cache/dithered";
const DITHER_URL   = "/assets/images/dithered";
const DITHER_OUT   = `_site${DITHER_URL}`;
const MAX_WIDTH    = 1500; // 2× para retina; exibido em ≤ 750 px via CSS
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

async function processImage(srcPath) {
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

  return { cached, filename };
}

function findInSrc(filename) {
  // Busca recursiva por nome de arquivo dentro de src/
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = walk(full); if (found) return found; }
      else if (entry.name === filename) return full;
    }
    return null;
  }
  return walk("src");
}

function resolveImagePath(src, inputPath) {
  const candidates = [
    path.join(path.dirname(inputPath), src),  // relativo ao arquivo fonte
    path.join("src", src.replace(/^\//, "")), // absoluto do input dir
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) return found;
  // Fallback: busca pelo nome do arquivo em qualquer lugar dentro de src/
  if (!src.includes("/")) return findInSrc(path.basename(src));
  return null;
}

// ─── Eleventy config ──────────────────────────────────────────────────────────

module.exports = function(eleventyConfig) {

  // Copia assets estáticos
  eleventyConfig.addPassthroughCopy("src/assets");

  // Slugify com suporte a português (remove acentos, espaços → hifens)
  const slugify = str => {
    if (!str) return "";
    return String(str)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  };
  eleventyConfig.addFilter("slugify", slugify);

  // Collections por post-type
  const types = ["note", "link", "quote", "image", "post"];
  types.forEach(type => {
    eleventyConfig.addCollection(type, function(collectionApi) {
      return collectionApi.getFilteredByTag(type).reverse();
    });
  });

  // Collection geral: todos os posts, ordem cronológica reversa
  eleventyConfig.addCollection("feed", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/posts/**/*.md")
      .reverse();
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
      .replace(/href="\//g, `href="${base}/`)
      .replace(/src="\//g, `src="${base}/`);
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
        const { cached, filename } = await processImage(absPath);
        fs.copyFileSync(cached, path.join(DITHER_OUT, filename));
        map.set(src, `${DITHER_URL}/${filename}`);
      } catch (e) {
        console.warn(`[dither] erro ao processar ${absPath}: ${e.message}`);
      }
    }));

    return content.replace(imgRe, (_, prefix, q, src, suffix) => {
      const newSrc = map.get(src);
      return newSrc ? `${prefix}${newSrc}${suffix}` : _;
    });
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
