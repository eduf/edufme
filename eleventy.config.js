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

  // Filtro de data legível
  eleventyConfig.addFilter("dateReadable", (date) => {
    return new Date(date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "America/Sao_Paulo"
    });
  });

  // Filtro de data para datetime attribute
  eleventyConfig.addFilter("dateISO", (date) => {
    return new Date(date).toISOString();
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
