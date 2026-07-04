// Helpers compartilhados entre eleventy.config.js e scripts/posse-publish.js.
// Ambos rodam com cwd na raiz do repositório.

const fs = require("fs");
const path = require("path");

// Slugify com suporte a português (remove acentos, espaços → hifens)
function slugify(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Busca recursiva por nome de arquivo dentro de src/
function findInSrc(filename, dir = "src") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findInSrc(filename, full);
      if (found) return found;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return null;
}

// Resolve o caminho de uma imagem referenciada num post
function resolveImagePath(src, inputPath) {
  const decoded = decodeURIComponent(src);
  const basename = path.basename(decoded);
  const candidates = [
    path.join(path.dirname(inputPath), decoded),  // relativo ao arquivo fonte
    path.join("src", decoded.replace(/^\//, "")), // absoluto do input dir
    path.join("src/assets/images", basename),     // posts antigos com prefixo images/
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) return found;
  // Fallback: busca recursiva pelo nome do arquivo em src/
  return findInSrc(basename);
}

module.exports = { slugify, findInSrc, resolveImagePath };
