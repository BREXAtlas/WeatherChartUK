import { formatDay, formatHour, formatUkDateTime } from './config.js';
import { makeElement, setBusy } from './accessibility.js';

const conditionIcons = [
  { test: /thunder|lightning/i, icon: '⛈', scene: 'rain' },
  { test: /snow|sleet|ice/i, icon: '❄', scene: 'snow' },
  { test: /heavy rain|downpour/i, icon: '🌧', scene: 'rain' },
  { test: /rain|shower|drizzle/i, icon: '🌦', scene: 'showers' },
  { test: /sun|clear|bright/i, icon: '☀', scene: 'sunny' },
  { test: /partly|cloud/i, icon: '⛅', scene: 'cloudy' },
  { test: /overcast|mist|fog/i, icon: '☁', scene: 'overcast' }
];

export function conditionPresentation(condition = '') {
  const presentation = conditionIcons.find(({ test }) => test.test(condition)) || { icon: '◌', scene: 'cloudy' };
  return /thunder|lightning/i.test(condition) ? { ...presentation, scene: 'lightning' } : presentation;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function number(value, fallback = 0) {
  return finite(value) ?? fallback;
}

function metric(value, formatter) {
  const parsed = finite(value);
  return parsed === null ? 'Unavailable' : formatter(parsed);
}

function setText(selector, value, root = document) {
  const element = root.querySelector(selector);
  if (element) element.textContent = value;
}

export function findLocation(locations, idOrName) {
  if (!Array.isArray(locations) || !locations.length) return null;
  const query = String(idOrName || '').trim().toLowerCase();
  return locations.find((location) =>
    location.id?.toLowerCase() === query || location.name?.toLowerCase() === query
  ) || locations.find((location) => location.id === 'london') || locations[0];
}

export function renderNationalSummary(forecastData, warningData) {
  const locations = forecastData.locations || [];
  const sample = Boolean(forecastData.sample);
  const warmest = locations
    .filter((location) => finite(location.current?.temperatureC) !== null)
    .sort((a, b) => finite(b.current.temperatureC) - finite(a.current.temperatureC))[0];
  const wettest = locations
    .filter((location) => finite(location.current?.precipitationProbability) !== null)
    .sort((a, b) => finite(b.current.precipitationProbability) - finite(a.current.precipitationProbability))[0];
  const warnings = warningData?.warnings || [];

  setText('[data-national-high]', warmest ? `${Math.round(number(warmest.current?.temperatureC))}° · ${warmest.name}` : '—');
  setText('[data-warning-count]', warningData?.unavailable ? '—' : String(warnings.length));
  setText('[data-location-count]', String(locations.length));
  setText('[data-national-summary]', warmest && wettest
    ? `${warmest.name} is the warmest ${sample ? 'sample ' : ''}location at ${Math.round(number(warmest.current?.temperatureC))}°C; ${wettest.name} carries the highest ${sample ? 'sample ' : ''}rain chance at ${Math.round(number(wettest.current?.precipitationProbability))}%.`
    : `${sample ? 'Sample n' : 'N'}ational summary unavailable.`);
  setText('[data-national-high-label]', sample ? 'Warmest sample' : 'Warmest location');
  setText('[data-warning-count-label]', warningData?.unavailable ? 'Warning data' : warningData?.sample ? 'Illustrative warnings' : 'Active warnings');
  setText('[data-location-count-label]', sample ? 'Sample cities' : 'Forecast locations');
}

export function renderCurrentLocation(location, source = {}, { sample = false } = {}) {
  if (!location) return;
  const current = location.current || {};
  const presentation = conditionPresentation(current.condition);
  setText('[data-location-heading]', `${location.name}, ${location.region}`);
  const sourceDisplay = sample
    ? (source.label || source.name || 'Sample data')
    : (source.attribution || source.label || source.name || 'Forecast data');
  setText('[data-location-source]', sourceDisplay);
  setText('[data-source-context]', sample
    ? `Showing a cached sample point for ${location.name}. This is not a live observation or a street-level forecast.`
    : `Showing the configured forecast point for ${location.name}. Check the source time and note that it may not represent street-level conditions.`);
  setText('[data-temperature]', metric(current.temperatureC, (value) => String(Math.round(value))).replace('Unavailable', '—'));
  setText('[data-condition]', current.condition || 'Condition unavailable');
  setText('[data-condition-icon]', presentation.icon);
  setText('[data-feels-like]', metric(current.feelsLikeC, (value) => `${Math.round(value)}°C`));
  setText('[data-observed-at]', formatUkDateTime(current.observedAt));

  setText('[data-metric="precipitation"]', metric(current.precipitationProbability, (value) => `${Math.round(value)}%`));
  setText('[data-metric="rainfall"]', metric(current.rainfallMm, (value) => `${value.toFixed(1)} mm`));
  setText('[data-metric="humidity"]', metric(current.humidityPercent, (value) => `${Math.round(value)}%`));
  setText('[data-metric="wind"]', metric(current.windKph, (value) => `${Math.round(value)} km/h`));
  setText('[data-metric="gust"]', metric(current.gustKph, (value) => `${Math.round(value)} km/h`));
  setText('[data-metric="visibility"]', metric(current.visibilityKm, (value) => `${value.toFixed(1)} km`));
  setText('[data-metric="cloud"]', metric(current.cloudCoverPercent, (value) => `${Math.round(value)}%`));
  const hasSunTimes = current.sunrise && current.sunset;
  setText('[data-metric="sun"]', hasSunTimes ? `${formatHour(current.sunrise)} / ${formatHour(current.sunset)}` : 'Unavailable');

  const card = document.querySelector('[data-current-card]');
  setBusy(card, false);
  const scene = document.querySelector('[data-weather-scene]');
  if (scene) {
    const gust = finite(current.gustKph);
    const temperature = finite(current.temperatureC);
    scene.dataset.weatherScene = gust !== null && gust >= 50
      ? 'windy'
      : temperature !== null && temperature >= 27
        ? 'hot'
        : temperature !== null && temperature <= 0
          ? 'cold'
          : presentation.scene;
  }
}

function bestOutdoorHour(hourly = []) {
  return hourly.slice(0, 12).filter((item) =>
    finite(item.precipitationProbability) !== null && finite(item.gustKph) !== null
  ).reduce((best, item) => {
    const score = finite(item.precipitationProbability) + finite(item.gustKph) * 1.4;
    return !best || score < best.score ? { item, score } : best;
  }, null)?.item;
}

function dryWindow(hourly = []) {
  for (let index = 0; index <= hourly.length - 3; index += 1) {
    const run = hourly.slice(index, index + 3);
    if (run.every((item) => {
      const rain = finite(item.precipitationProbability);
      const gust = finite(item.gustKph);
      return rain !== null && gust !== null && rain < 25 && gust < 35;
    })) return run;
  }
  return null;
}

export function interpretationsFor(location, { suppressHumour = false } = {}) {
  const current = location.current || {};
  const hourly = location.hourly || [];
  const feels = number(current.feelsLikeC);
  const rain = number(current.precipitationProbability);
  const rainfall = number(current.rainfallMm);
  const wind = number(current.windKph);
  const gust = number(current.gustKph);
  const humidity = number(current.humidityPercent);
  const bestHour = bestOutdoorHour(hourly);
  const washingWindow = dryWindow(hourly);

  if (suppressHumour) {
    return [
      { icon: '!', title: 'Clothing', text: feels <= 10 ? 'Wear warm, weather-resistant layers and follow the official warning guidance.' : 'Choose weather-resistant layers and follow the official warning guidance.' },
      { icon: '!', title: 'Rain protection', text: gust >= 45 ? 'Strong gusts can make umbrellas unsafe or ineffective; use suitable waterproof clothing and follow official advice.' : 'Use suitable rain protection if needed and follow the full official warning.' },
      { icon: '!', title: 'Travel and school run', text: 'Check current travel information, allow extra time and follow any official instructions before leaving.' },
      { icon: '!', title: 'Outdoor activity', text: 'Postpone or change outdoor plans when the official warning or local conditions make them unsafe.' },
      { icon: '!', title: 'Laundry and loose items', text: gust >= 40 ? 'Bring in loose outdoor items where it is safe to do so; do not take risks during strong winds.' : 'Keep outdoor tasks secondary to the official warning guidance.' },
      { icon: '!', title: 'Garden safety', text: 'Avoid exposed areas and secure loose items only when it is safe to act.' },
      { icon: '!', title: 'Planning note', text: 'Use the official forecast, full warning details and emergency guidance for decisions.' },
      { icon: '!', title: 'Personal comfort', text: 'Safety impacts take priority; check on vulnerable people when official guidance recommends it.' }
    ];
  }

  const coat = feels <= 7
    ? 'A warm, wind-resistant coat is the sensible calculated verdict.'
    : feels <= 14 || rain >= 45
      ? 'A light waterproof layer earns its place today.'
      : 'Probably no heavy coat, but check before heading out.';
  const umbrella = gust >= 45
    ? 'Rain may be possible, but the displayed gusts make a hood the sturdier option.'
    : rain >= 65 || rainfall >= 1
      ? 'Brolly territory in the displayed forecast. Keep the official source close.'
      : rain >= 30
        ? 'A compact brolly would be a reasonable just-in-case companion.'
        : 'Low calculated umbrella odds — never quite zero in Britain.';
  const school = gust >= 50 || rain >= 75
    ? 'Allow extra time and check current travel and warning guidance before leaving.'
    : rain >= 40
      ? 'A waterproof layer may make the school run less soggy.'
      : 'The displayed period looks fairly settled; check again before the bell.';
  const dog = suppressHumour
    ? 'Follow official warning guidance before planning outdoor activity.'
    : bestHour
      ? `${formatHour(bestHour.time)} has the calmest displayed combination of rain chance and gusts.`
      : 'No reliable walk window is available in the displayed period.';
  const washing = washingWindow
    ? `There is a possible three-hour dry spell from ${formatHour(washingWindow[0].time)}. No promises from the clouds.`
    : 'No convincing three-hour line-drying window appears in the displayed forecast.';
  const garden = rain >= 60 || gust >= 45
    ? 'Sofa has the stronger calculated case; secure loose garden items if needed.'
    : feels >= 16 && rain < 30
      ? 'Garden has a fair calculated case, with sunscreen and current advice as appropriate.'
      : 'A short garden spell may work; keep an eye on the next few hours.';
  const kettle = suppressHumour
    ? 'Use the official forecast and warnings for planning.'
    : feels <= 8 || rain >= 70
      ? 'A two-cuppa sort of spell, according to our entirely unofficial index.'
      : feels >= 24
        ? 'Maybe swap the kettle for water and check current heat-health guidance.'
        : 'One-cuppa conditions. Your mug may disagree.';
  const hair = suppressHumour
    ? 'Strong-weather impacts matter more than appearance; follow current guidance.'
    : gust >= 45
      ? 'High calculated chance of improvised wind styling.'
      : humidity >= 85 || rain >= 55
        ? 'Moisture is doing the styling today.'
        : 'Hair forecast: relatively cooperative, by British standards.';

  return [
    { icon: '🧥', title: 'Coat or no coat?', text: coat },
    { icon: '☂', title: 'Umbrella odds', text: umbrella },
    { icon: '🎒', title: 'School-run verdict', text: school },
    { icon: '🐕', title: 'Dog-walk window', text: dog },
    { icon: '◫', title: 'Washing-line window', text: washing },
    { icon: '🌱', title: 'Garden or sofa?', text: garden },
    { icon: '☕', title: 'Kettle index', text: kettle },
    { icon: '〰', title: 'Hair forecast', text: hair }
  ];
}

export function renderInterpretations(location, options = {}) {
  const container = document.querySelector('[data-meaning-grid]');
  if (!container) return;
  container.replaceChildren();
  interpretationsFor(location, options).forEach((item) => {
    const card = makeElement('article', { className: 'meaning-card' });
    card.append(
      makeElement('span', { className: 'meaning-card__icon', text: item.icon, attributes: { 'aria-hidden': 'true' } }),
      makeElement('h3', { text: item.title }),
      makeElement('p', { text: item.text })
    );
    container.append(card);
  });
}

export function renderDaily(location, { sample = false } = {}) {
  const container = document.querySelector('[data-daily-list]');
  if (!container) return;
  const periods = location.daily || [];
  const hourlyDerived = !sample && periods.some((item) => item.derivedFrom === 'hourly');
  setText('#daily-title', sample ? 'Multi-day sample outlook' : hourlyDerived ? '48-hour derived outlook' : 'Multi-day forecast');
  container.replaceChildren();
  periods.forEach((item) => {
    const presentation = conditionPresentation(item.condition);
    const day = formatDay(item.date);
    const card = makeElement('article', { className: 'daily-card' });
    const dayLabel = makeElement('p', { className: 'daily-card__day', text: day.day });
    const date = makeElement('time', { className: 'daily-card__date', text: day.date, attributes: { datetime: item.date } });
    const icon = makeElement('span', { className: 'daily-card__icon', text: presentation.icon, attributes: { 'aria-hidden': 'true' } });
    const title = makeElement('h3', { text: item.condition || 'Forecast unavailable' });
    const temps = makeElement('p', { className: 'daily-card__temps' });
    temps.append(
      makeElement('strong', { text: metric(item.highC, (value) => `${Math.round(value)}°`) }),
      makeElement('span', { text: metric(item.lowC, (value) => `${Math.round(value)}°`) })
    );
    const summary = makeElement('p', { className: 'daily-card__summary', text: item.summary || 'No daily summary is available.' });
    const facts = makeElement('dl');
    [
      ['Rain', finite(item.precipitationProbability) === null && finite(item.rainfallMm) === null
        ? 'Unavailable'
        : `${metric(item.precipitationProbability, (value) => `${Math.round(value)}%`)} · ${metric(item.rainfallMm, (value) => `${value.toFixed(1)} mm`)}`],
      ['Wind', finite(item.windKph) === null && finite(item.gustKph) === null
        ? 'Unavailable'
        : `${metric(item.windKph, (value) => String(Math.round(value)))} / ${metric(item.gustKph, (value) => String(Math.round(value)))} km/h`],
      ['Sun', item.sunrise && item.sunset ? `${formatHour(item.sunrise)}–${formatHour(item.sunset)}` : 'Unavailable from the hourly product']
    ].forEach(([term, value]) => {
      const row = makeElement('div');
      row.append(makeElement('dt', { text: term }), makeElement('dd', { text: value }));
      facts.append(row);
    });
    card.append(dayLabel, date, icon, title, temps, summary, facts);
    container.append(card);
  });
}

export function renderLocationTable(locations, { sample = false } = {}) {
  const body = document.querySelector('[data-location-table]');
  if (!body) return;
  const caption = body.closest('table')?.querySelector('caption');
  if (caption?.hasAttribute('data-location-table-caption')) {
    caption.textContent = sample ? 'Illustrative conditions, not live observations' : 'Available forecast locations and current conditions';
  }
  body.replaceChildren();
  locations.forEach((location) => {
    const current = location.current || {};
    const row = document.createElement('tr');
    const nameCell = makeElement('th', { text: location.name, attributes: { scope: 'row' } });
    [
      location.region,
      current.condition || '—',
      metric(current.temperatureC, (value) => `${Math.round(value)}°C`),
      metric(current.precipitationProbability, (value) => `${Math.round(value)}%`),
      metric(current.windKph, (value) => `${Math.round(value)} km/h`)
    ].forEach((value) => row.append(makeElement('td', { text: value })));
    row.prepend(nameCell);
    body.append(row);
  });
}
