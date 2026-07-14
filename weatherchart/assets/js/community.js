import { formatHour, formatUkDateTime } from './config.js';
import { makeElement, safeExternalLink } from './accessibility.js';

const locationAliases = Object.freeze({
  'greater manchester': 'manchester',
  'cardiff area': 'cardiff',
  norfolk: 'norwich',
  'glasgow area': 'glasgow',
  london: 'london',
  'belfast area': 'belfast'
});

const basisLabels = Object.freeze({
  platform_geotag: 'Platform geotag',
  author_explicit: 'Location named by author',
  keyword_only: 'Matched by search words',
  unknown: 'Location not verified'
});

const platformLabels = Object.freeze({
  youtube: 'YouTube',
  x: 'X',
  tiktok: 'TikTok',
  mastodon: 'Mastodon'
});

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function fillSelect(select, values, allLabel) {
  if (!select) return;
  const current = select.value;
  select.replaceChildren(makeElement('option', { text: allLabel, attributes: { value: 'all' } }));
  values.forEach((value) => select.append(makeElement('option', { text: value, attributes: { value } })));
  select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
}

function locationForItem(item, forecasts) {
  const label = String(item.location?.label || '').toLowerCase();
  const id = locationAliases[label];
  return forecasts.find((location) => location.id === id)
    || forecasts.find((location) => label.includes(location.name.toLowerCase()))
    || null;
}

function ukDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function nearestForecastPeriod(item, forecast) {
  const publishedAt = Date.parse(item?.publishedAt ?? '');
  const dateKey = ukDateKey(item?.publishedAt);
  if (!Number.isFinite(publishedAt) || !dateKey || !Array.isArray(forecast?.hourly)) return null;
  const sameDate = forecast.hourly.filter((period) => ukDateKey(period?.time) === dateKey);
  if (!sameDate.length) return null;
  return sameDate.reduce((nearest, period) => {
    const distance = Math.abs(Date.parse(period.time) - publishedAt);
    return !nearest || distance < nearest.distance ? { period, distance } : nearest;
  }, null)?.period || null;
}

function numericValue(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] === null || record?.[key] === undefined || record?.[key] === '') continue;
    const value = Number(record?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function comparisonFor(item, forecast) {
  const dataset = 'cached forecast';
  if (!forecast) return `No matching ${dataset} point is available, so WeatherChart makes no comparison.`;
  const period = nearestForecastPeriod(item, forecast);
  if (!period) return `No ${dataset} period is available for this post's UK calendar date, so WeatherChart makes no comparison.`;
  const keywords = (item.keywords || []).join(' ').toLowerCase();
  const rain = numericValue(period, 'precipitationProbability', 'precipitationProbabilityPercent');
  const gust = numericValue(period, 'gustKph', 'windGustKph');
  const time = formatHour(period.time);
  if (/snow|sleet/.test(keywords)) {
    return /snow|sleet/.test(String(period.condition).toLowerCase())
      ? `The nearest ${forecast.name} ${dataset} period at ${time} also shows wintry conditions, but this does not verify the post.`
      : `This chatter mentions snow, but the nearest ${forecast.name} ${dataset} period at ${time} does not confirm it.`;
  }
  if (/rain|shower|drizzle/.test(keywords)) {
    if (rain === null) return `The nearest same-date ${forecast.name} ${dataset} period at ${time} has no rain-probability value, so it cannot verify the post.`;
    return rain >= 55
      ? `${forecast.name} chatter mentions rain; the nearest same-date ${dataset} period at ${time} shows a ${Math.round(rain)}% rain chance.`
      : `${forecast.name} chatter mentions rain, while the nearest same-date ${dataset} period at ${time} shows a ${Math.round(rain)}% chance.`;
  }
  if (/wind|gust/.test(keywords)) {
    if (gust === null) return `The nearest same-date ${forecast.name} ${dataset} period at ${time} has no gust value, so it cannot verify the post.`;
    return `The nearest same-date ${forecast.name} ${dataset} period at ${time} shows gusts around ${Math.round(gust)} km/h; that is context, not verification.`;
  }
  return `The nearest same-date ${dataset} point is ${forecast.name} at ${time}; its condition is ${period.condition || 'unavailable'}.`;
}

function safeActionFor(forecast, seriousWarning, period = null) {
  if (seriousWarning) return 'Follow the current official warning and check travel before leaving.';
  if (!forecast) return 'Check the current official forecast before making plans.';
  const current = period || forecast.current || {};
  const gust = numericValue(current, 'gustKph');
  const rain = numericValue(current, 'precipitationProbability', 'precipitationProbabilityPercent');
  const temperature = numericValue(current, 'temperatureC');
  if (gust !== null && gust >= 50) return 'Check travel and avoid exposed routes if current official guidance advises it.';
  if (rain !== null && rain >= 60) return 'Check routes and take waterproofs if the current official forecast agrees.';
  if (temperature !== null && temperature >= 25) return 'Carry water and check current heat-health advice.';
  return 'Check the current official forecast before heading out.';
}

export function currentCommunityItems(data, now = Date.now()) {
  const checkedAt = now instanceof Date ? now.getTime() : Number(now);
  if (data?.sample !== false || !Number.isFinite(checkedAt) || !Array.isArray(data?.items)) return [];
  return data.items.filter((item) =>
    item.familySafe === true
    && ['approved', 'manually-approved', 'automated-filtered'].includes(item.reviewStatus)
    && Number.isFinite(Date.parse(item.publishedAt))
    && Number.isFinite(Date.parse(item.expiresAt))
    && Date.parse(item.expiresAt) > checkedAt
  );
}

export function initialiseCommunity(data, forecasts = [], { limit = Infinity, seriousWarning = false } = {}) {
  const container = document.querySelector('[data-community-list]');
  if (!container) return { itemCount: 0 };
  const section = container.closest('[data-community-section]');
  const platformSelect = document.querySelector('[data-community-filters] [data-filter="platform"]');
  const citySelect = document.querySelector('[data-community-filters] [data-filter="city"]');
  const weatherSelect = document.querySelector('[data-community-filters] [data-filter="weather"]');
  const filters = container.parentElement?.querySelector('[data-community-filters]');
  const items = currentCommunityItems(data);

  if (!items.length) {
    container.replaceChildren();
    if (section) section.hidden = true;
    if (filters) filters.hidden = true;
    return { itemCount: 0 };
  }
  if (section) section.hidden = false;
  if (filters) filters.hidden = false;
  fillSelect(platformSelect, unique(items.map((item) => item.platform)), 'All platforms');
  fillSelect(citySelect, unique(items.map((item) => item.location?.label)), 'All cities');
  fillSelect(weatherSelect, unique(items.flatMap((item) => item.keywords || [])), 'All weather');

  const render = () => {
    const platform = platformSelect?.value || 'all';
    const city = citySelect?.value || 'all';
    const weather = weatherSelect?.value || 'all';
    const visible = items.filter((item) =>
      (platform === 'all' || item.platform === platform)
      && (city === 'all' || item.location?.label === city)
      && (weather === 'all' || item.keywords?.includes(weather))
    ).slice(0, limit);
    container.replaceChildren();
    if (!visible.length) {
      container.append(makeElement('p', { className: 'empty-state', text: 'No current public posts match those filters.' }));
      return;
    }

    visible.forEach((item) => {
      const forecast = locationForItem(item, forecasts);
      const period = nearestForecastPeriod(item, forecast);
      const card = makeElement('article', { className: 'community-card' });
      const top = makeElement('div', { className: 'community-card__topline' });
      const platformName = platformLabels[item.platform] || item.sourceName || 'Public source';
      top.append(
        makeElement('span', { className: 'platform-badge', text: platformName }),
        makeElement('time', { className: 'community-card__date', text: formatUkDateTime(item.publishedAt), attributes: { datetime: item.publishedAt } })
      );
      const title = makeElement('h3', { text: item.title || 'Public weather post' });
      const handle = item.authorHandle ? ` (${item.authorHandle})` : '';
      const author = makeElement('p', {
        className: 'community-card__author',
        text: `Author: ${item.author || 'Public account'}${handle} · Place: ${item.location?.label || 'Location not verified'}`
      });
      const source = makeElement('p', {
        className: 'community-card__author',
        text: `Source: ${item.sourceName || platformName}${item.sourceHost ? ` on ${item.sourceHost}` : ''}`
      });
      const confidence = makeElement('span', {
        className: 'confidence-badge',
        text: `${basisLabels[item.location?.basis] || 'Location not verified'} · ${item.location?.confidence || 'unknown'} confidence`
      });
      const excerpt = makeElement('p', { className: 'community-card__excerpt', text: item.excerpt || 'No permitted excerpt is available.' });
      const comparison = makeElement('p', { className: 'community-card__comparison' });
      comparison.append(makeElement('strong', { text: 'Weather context' }), document.createTextNode(comparisonFor(item, forecast)));
      const action = makeElement('p', { className: 'community-card__action' });
      action.append(makeElement('strong', { text: 'Based on the forecast' }), document.createTextNode(safeActionFor(forecast, seriousWarning, period)));
      const footer = makeElement('div', { className: 'community-card__footer' });
      const url = safeExternalLink(item.url);
      if (url) footer.append(makeElement('a', { text: `View original on ${platformName} ↗`, attributes: { href: url, rel: 'external noopener' } }));
      footer.append(makeElement('a', { text: 'Report this card', attributes: { href: 'privacy.html#corrections' } }));
      card.append(top, title, author, source, confidence, excerpt, comparison, action, footer);
      container.append(card);
    });
  };

  if (platformSelect) platformSelect.onchange = render;
  if (citySelect) citySelect.onchange = render;
  if (weatherSelect) weatherSelect.onchange = render;
  render();
  return { itemCount: items.length };
}
