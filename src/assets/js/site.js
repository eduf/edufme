// Prefetch de links internos ao apontar/tocar (deduplicado).
// Antes era prefetch de todos os links no load — desperdiçava banda.
const prefetched = new Set([location.href]);

function prefetchLink(target) {
  const link = target && target.closest ? target.closest('a[href^="/"]') : null;
  if (!link || prefetched.has(link.href)) return;
  prefetched.add(link.href);
  const prefetch = document.createElement('link');
  prefetch.rel = 'prefetch';
  prefetch.href = link.href;
  document.head.appendChild(prefetch);
}

document.addEventListener('pointerover', e => prefetchLink(e.target));
document.addEventListener('touchstart', e => prefetchLink(e.target), { passive: true });

// Hamburger menu
const navToggle = document.querySelector('.nav-toggle');
const sidebar   = document.querySelector('.tui-sidebar');
if (navToggle && sidebar) {
  navToggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
    navToggle.textContent = isOpen ? '✕' : '≡';
  });
  // Fecha ao clicar num link do menu
  sidebar.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => {
      sidebar.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.textContent = '≡';
    })
  );
}

// Seletor de tema
const themeSelect = document.getElementById('theme-select');
const savedTheme  = localStorage.getItem('eduf-theme');

if (themeSelect) {
  if (savedTheme) themeSelect.value = savedTheme;

  themeSelect.addEventListener('change', () => {
    const name = themeSelect.value;
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('eduf-theme', name);
  });
}
