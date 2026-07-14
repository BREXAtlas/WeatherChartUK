export function initialiseNavigation() {
  const button = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-site-nav]');
  if (!button || !nav) return;

  const close = () => {
    button.setAttribute('aria-expanded', 'false');
    button.querySelector('.sr-only').textContent = 'Open menu';
    nav.dataset.open = 'false';
  };

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('.sr-only').textContent = open ? 'Close menu' : 'Open menu';
    nav.dataset.open = String(open);
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      close();
      button.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 68.01rem)').matches) close();
  });
}

export function initialiseMotionAndVisibility() {
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotion = () => {
    document.documentElement.dataset.reducedMotion = String(motionQuery.matches);
  };
  updateMotion();
  motionQuery.addEventListener?.('change', updateMotion);

  document.addEventListener('visibilitychange', () => {
    document.body.dataset.pageHidden = String(document.hidden);
  });
}

export function announce(message, state = 'ready') {
  const region = document.querySelector('[data-app-status]');
  if (!region) return;
  region.textContent = message;
  region.dataset.state = state;
}

export function setBusy(element, busy) {
  if (!element) return;
  element.setAttribute('aria-busy', String(Boolean(busy)));
}

export function safeExternalLink(url) {
  try {
    const parsed = new URL(url, document.baseURI);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function makeElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => {
      if (value !== undefined && value !== null) element.setAttribute(name, String(value));
    });
  }
  return element;
}
