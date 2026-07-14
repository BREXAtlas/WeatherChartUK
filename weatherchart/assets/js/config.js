export const SITE = Object.freeze({
  name: 'WeatherChart UK',
  previewBase: 'https://brexatlas.github.io/WeatherChartUK/',
  productionBase: 'https://weatherchart.uk/',
  coolIsleBase: 'https://brexatlas.github.io/Cool-Isle/'
});

export const DATA_FILES = Object.freeze({
  forecast: 'data/forecast.json',
  warnings: 'data/warnings.json',
  news: 'data/news.json',
  community: 'data/community.json',
  status: 'data/status.json'
});

export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const CRITICAL_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function isProductionDomain() {
  return /(^|\.)weatherchart\.uk$/i.test(window.location.hostname);
}

export function dataUrl(path, cacheBust = true) {
  const url = new URL(path, document.baseURI);
  if (cacheBust) url.searchParams.set('checked', String(Date.now()));
  return url;
}

export function configureDeploymentLinks() {
  const production = isProductionDomain();
  const page = document.location.pathname.split('/').pop() || 'index.html';
  const canonicalPath = page === 'index.html' ? '' : page;
  const canonical = new URL(canonicalPath, production ? SITE.productionBase : SITE.previewBase);
  const canonicalElement = document.querySelector('[data-canonical]');
  if (canonicalElement) canonicalElement.href = canonical.href;

  const socialImage = new URL('assets/images/weatherchart-social.png', production ? SITE.productionBase : SITE.previewBase).href;
  document.querySelectorAll('meta[property="og:url"]').forEach((element) => { element.content = canonical.href; });
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((element) => { element.content = socialImage; });
  const structuredData = document.querySelector('script[type="application/ld+json"]');
  if (structuredData) {
    try {
      const value = JSON.parse(structuredData.textContent);
      if (value?.['@type'] === 'WebSite') {
        value.url = (production ? SITE.productionBase : SITE.previewBase);
        structuredData.textContent = JSON.stringify(value);
      }
    } catch {
      // The committed JSON-LD is statically validated; leave it untouched if parsing ever fails.
    }
  }

  document.querySelectorAll('[data-cool-isle-link]').forEach((link) => {
    link.href = SITE.coolIsleBase;
  });
  document.querySelectorAll('[data-cool-isle-path]').forEach((link) => {
    const path = link.dataset.coolIslePath || '';
    link.href = new URL(path, SITE.coolIsleBase).href;
  });
}

export function formatUkDateTime(value, options = {}) {
  if (value === null || value === undefined || value === '') return 'Time unavailable';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  const formatOptions = options.dateOnly
    ? { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }
    : { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('en-GB', formatOptions).format(date);
}

export function formatHour(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function formatDay(value) {
  if (value === null || value === undefined || value === '') return { day: '—', date: '—' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: '—', date: '—' };
  return {
    day: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(date),
    date: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' }).format(date)
  };
}
