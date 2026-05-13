module.exports = function(eleventyConfig) {

  // Copia assets estáticos
  eleventyConfig.addPassthroughCopy("src/assets");

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
