import { makeElement } from './accessibility.js';
import { optionalMapsAllowed } from './privacy-choices.js';

const REGION_CENTRES = Object.freeze({
  'North West England': [54.0, -2.65],
  'Yorkshire and the Humber': [53.9, -1.35],
  'West Central Scotland': [55.88, -4.45],
  Scotland: [56.5, -4.0],
  Wales: [52.3, -3.7],
  'Northern Ireland': [54.7, -6.7],
  England: [52.9, -1.5],
  'South West England': [50.7, -3.7],
  'South East England': [51.2, .1]
});

const COMMUNITY_ALIASES = Object.freeze({
  'Greater Manchester': 'manchester',
  'Cardiff area': 'cardiff',
  Norfolk: 'norwich',
  'Glasgow area': 'glasgow'
});

const LEAFLET_CSS = Object.freeze({
  url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='
});
const LEAFLET_SCRIPT = Object.freeze({
  url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='
});
let leafletPromise;

function unloadLeaflet() {
  document.querySelectorAll('[data-leaflet-styles], [data-leaflet-script]').forEach((element) => element.remove());
  leafletPromise = undefined;
  try {
    delete window.L;
  } catch {
    window.L = undefined;
  }
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function markerColour(layer, value) {
  if (value === null) return '#65758b';
  if (layer === 'temperature') {
    if (value >= 25) return '#d64848';
    if (value >= 18) return '#ed8b23';
    if (value >= 10) return '#547aa5';
    return '#278daa';
  }
  if (layer === 'rain') return value >= 70 ? '#25245e' : value >= 35 ? '#547aa5' : '#42c7f5';
  if (layer === 'wind') return value >= 50 ? '#c81e3a' : value >= 30 ? '#6c4ab6' : '#547aa5';
  if (layer === 'warnings') return value === 'red' ? '#c81e3a' : value === 'amber' ? '#ed8b23' : '#f7d64a';
  return '#6c4ab6';
}

function markerIcon(L, display, colour) {
  const wrapper = document.createElement('div');
  wrapper.className = 'weather-marker';
  wrapper.style.setProperty('--marker-colour', colour);
  const text = document.createElement('span');
  text.textContent = display;
  wrapper.append(text);
  return L.divIcon({
    className: 'leaflet-div-icon',
    html: wrapper.outerHTML,
    iconSize: [40, 40],
    iconAnchor: [20, 38],
    popupAnchor: [0, -35]
  });
}

function popup(title, lines) {
  const root = document.createElement('div');
  root.append(makeElement('strong', { text: title }));
  lines.forEach((line) => root.append(makeElement('p', { text: line })));
  return root;
}

function locationEntries(layer, locations) {
  const qualifier = '';
  return locations.map((location) => {
    const current = location.current || {};
    if (layer === 'rain') {
      const rawValue = number(current.precipitationProbability);
      const rainfall = number(current.rainfallMm);
      const value = rawValue === null ? null : Math.round(rawValue);
      return { coordinates: [location.latitude, location.longitude], display: value === null ? '?' : `${value}%`, colour: markerColour(layer, value), title: location.name, lines: [value === null ? 'Rain chance unavailable' : `${value}% ${qualifier}rain chance`, rainfall === null ? 'Rainfall unavailable' : `${rainfall.toFixed(1)} mm ${qualifier}rainfall`] };
    }
    if (layer === 'wind') {
      const rawValue = number(current.windKph);
      const rawGust = number(current.gustKph);
      const value = rawValue === null ? null : Math.round(rawValue);
      return { coordinates: [location.latitude, location.longitude], display: value === null ? '?' : `${value}`, colour: markerColour(layer, value), title: location.name, lines: [value === null ? 'Wind speed unavailable' : `${value} km/h ${qualifier}wind`, rawGust === null ? 'Gust speed unavailable' : `${Math.round(rawGust)} km/h ${qualifier}gusts`] };
    }
    const rawValue = number(current.temperatureC);
    const value = rawValue === null ? null : Math.round(rawValue);
    return { coordinates: [location.latitude, location.longitude], display: value === null ? '?' : `${value}°`, colour: markerColour('temperature', value), title: location.name, lines: [value === null ? 'Temperature unavailable' : `${value}°C ${qualifier}temperature`, current.condition || 'Condition unavailable'] };
  });
}

function warningEntries(warnings, sample) {
  return warnings.flatMap((warning) => {
    const severity = String(warning.severity || 'yellow').toLowerCase();
    const geometry = warning.geometry;
    if (geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type) && Array.isArray(geometry.coordinates)) {
      return [{
        geometry,
        display: 'area',
        colour: markerColour('warnings', severity),
        title: `${severity.toUpperCase()} — ${warning.title || 'weather warning'}`,
        lines: [sample ? 'Illustrative warning geometry, not an active warning.' : 'Geometry supplied with the official warning feed item—read the warning card for full details.']
      }];
    }
    return (warning.regions || []).map((region) => ({
      coordinates: REGION_CENTRES[region] || [54.5, -3.2],
      display: '!',
      colour: markerColour('warnings', severity),
      title: `${severity.toUpperCase()} — ${region}`,
      lines: [sample ? 'Illustrative warning card, not an active warning.' : 'Official warning feed region—read the linked warning card for full details.', 'A coarse regional marker is used because no geometry is supplied.']
    }));
  });
}

function communityEntries(items, locations, sample) {
  return items.flatMap((item) => {
    if (!item.location?.label || item.location.basis === 'unknown') return [];
    const id = COMMUNITY_ALIASES[item.location?.label]
      || locations.find((location) => String(item.location?.label).toLowerCase().includes(location.name.toLowerCase()))?.id;
    const location = locations.find((candidate) => candidate.id === id);
    if (!location) return [];
    return [{
      coordinates: [location.latitude, location.longitude],
      display: '●',
      colour: markerColour('community'),
      title: `${item.location.label} ${sample ? 'sample ' : ''}chatter`,
      lines: [`${item.platform} · ${item.location.confidence} location confidence`, 'Public weather chatter—not a verified weather observation.']
    }];
  });
}

function loadStylesheet(timeoutMs) {
  const existing = document.querySelector('link[data-leaflet-styles]');
  if (existing?.sheet) return Promise.resolve(true);
  return new Promise((resolve) => {
    const link = existing || document.createElement('link');
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(loaded);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    link.addEventListener('load', () => finish(true), { once: true });
    link.addEventListener('error', () => finish(false), { once: true });
    if (!existing) {
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS.url;
      link.integrity = LEAFLET_CSS.integrity;
      link.crossOrigin = 'anonymous';
      link.dataset.leafletStyles = '';
      document.head.append(link);
    }
  });
}

function loadScript(timeoutMs) {
  if (window.L) return Promise.resolve(true);
  return new Promise((resolve) => {
    const existing = document.querySelector('script[data-leaflet-script]');
    const script = existing || document.createElement('script');
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(loaded && Boolean(window.L));
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    script.addEventListener('load', () => finish(true), { once: true });
    script.addEventListener('error', () => finish(false), { once: true });
    if (!existing) {
      script.src = LEAFLET_SCRIPT.url;
      script.integrity = LEAFLET_SCRIPT.integrity;
      script.crossOrigin = 'anonymous';
      script.dataset.leafletScript = '';
      document.head.append(script);
    }
  });
}

export function loadLeaflet(timeoutMs = 8000) {
  if (!optionalMapsAllowed()) return Promise.resolve(null);
  if (window.L && document.querySelector('link[data-leaflet-styles]')?.sheet) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = Promise.all([loadStylesheet(timeoutMs), loadScript(timeoutMs)])
      .then(([stylesReady, scriptReady]) => stylesReady && scriptReady && optionalMapsAllowed() ? window.L : null)
      .catch(() => null);
  }
  return leafletPromise;
}

export function initialiseWeatherMap(initialData = {}) {
  const mapElement = document.querySelector('[data-weather-map]');
  const switcher = document.querySelector('[data-layer-switcher]');
  const keyTitle = document.querySelector('[data-map-key-title]');
  const keyCopy = document.querySelector('[data-map-key-copy]');
  const keyList = document.querySelector('[data-map-key-list]');
  if (!mapElement) return;

  let dataState = {
    locations: initialData.locations || [],
    warnings: initialData.warnings || [],
    community: initialData.community || [],
    warningSample: Boolean(initialData.warningSample),
    warningUnavailable: Boolean(initialData.warningUnavailable),
    communitySample: Boolean(initialData.communitySample)
  };
  let map = null;
  let markerLayer = null;
  let requestedLayer = switcher?.querySelector('input:checked')?.value || 'temperature';

  const showPrivacyPlaceholder = () => {
    mapElement.setAttribute('aria-label', 'Optional interactive map is off');
    const placeholder = makeElement('div', {
      className: 'privacy-map-placeholder',
      attributes: { role: 'status' }
    });
    placeholder.append(
      makeElement('p', { text: 'The optional interactive map is off. Forecast values and the accessible location table remain available without it.' }),
      makeElement('button', {
        text: 'Review map privacy choice',
        attributes: { type: 'button', 'data-privacy-settings': '' }
      })
    );
    mapElement.replaceChildren(placeholder);
  };

  const entriesFor = (layer) => {
    if (layer === 'warnings') return warningEntries(dataState.warnings, dataState.warningSample);
    if (layer === 'community') return communityEntries(dataState.community, dataState.locations, dataState.communitySample);
    return locationEntries(layer, dataState.locations);
  };

  const updateKey = (layer, entries) => {
    const details = {
      temperature: ['Forecast temperatures', 'Configured forecast-point temperatures with source context on the page.'],
      rain: ['Forecast rain chance', 'Percentages show precipitation probability at configured forecast points.'],
      wind: ['Forecast wind speed', 'Markers show wind speed; select one for gust information.'],
      warnings: [dataState.warningUnavailable ? 'Warning layer unavailable' : dataState.warningSample ? 'Illustrative warning regions' : 'Official warning regions', dataState.warningUnavailable ? 'The warning source could not be refreshed. Check the official Met Office warning service.' : 'Coarse markers only—no warning polygons have been invented.'],
      community: [dataState.communitySample ? 'Sample community discussion' : 'Community discussion', 'Coarse city markers; public chatter is not verified.']
    }[layer];
    if (keyTitle) keyTitle.textContent = details[0];
    if (keyCopy) keyCopy.textContent = details[1];
    if (!keyList) return;
    keyList.replaceChildren();
    entries.slice(0, 12).forEach((entry) => {
      const item = makeElement('li');
      const dot = makeElement('span', { className: 'map-key-dot', attributes: { 'aria-hidden': 'true' } });
      dot.style.setProperty('--marker-colour', entry.colour);
      item.append(dot, document.createTextNode(`${entry.title}: ${entry.display}`));
      keyList.append(item);
    });
  };

  const renderLayer = (layer) => {
    requestedLayer = layer;
    const entries = entriesFor(layer);
    updateKey(layer, entries);
    mapElement.setAttribute('aria-label', 'Interactive map of UK weather locations');
    if (!map || !window.L) return;
    markerLayer?.clearLayers();
    entries.forEach((entry) => {
      if (entry.geometry) {
        const area = window.L.geoJSON({ type: 'Feature', geometry: entry.geometry, properties: {} }, {
          style: { color: entry.colour, weight: 3, opacity: .9, fillColor: entry.colour, fillOpacity: .18 },
          onEachFeature: (_feature, layer) => layer.bindPopup(popup(entry.title, entry.lines))
        });
        area.addTo(markerLayer);
        return;
      }
      const coordinates = entry.coordinates.map(Number);
      if (!coordinates.every(Number.isFinite)) return;
      const marker = window.L.marker(coordinates, {
        icon: markerIcon(window.L, entry.display, entry.colour),
        keyboard: true,
        title: `${entry.title}: ${entry.display}`,
        alt: `${entry.title}: ${entry.display}`
      });
      marker.bindPopup(popup(entry.title, entry.lines));
      marker.addTo(markerLayer);
    });
  };

  const createMap = async () => {
    if (map) return;
    if (!optionalMapsAllowed()) {
      showPrivacyPlaceholder();
      return;
    }
    const L = await loadLeaflet();
    if (!optionalMapsAllowed()) {
      unloadLeaflet();
      showPrivacyPlaceholder();
      return;
    }
    if (!L) {
      mapElement.replaceChildren(makeElement('p', { className: 'map-placeholder', text: 'The interactive map library could not load. The accessible location table remains available below.' }));
      return;
    }
    mapElement.replaceChildren();
    map = L.map(mapElement, { scrollWheelZoom: false, minZoom: 4, maxZoom: 12 }).setView([54.5, -3.2], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    renderLayer(requestedLayer);
  };

  const removeMap = () => {
    markerLayer?.clearLayers();
    map?.remove();
    markerLayer = null;
    map = null;
    unloadLeaflet();
    showPrivacyPlaceholder();
  };

  window.addEventListener('privacychoicechange', (event) => {
    if (event.detail?.optionalMaps) createMap();
    else removeMap();
  });

  switcher?.addEventListener('change', (event) => {
    if (event.target.matches('input[name="map-layer"]')) renderLayer(event.target.value);
  });
  renderLayer(requestedLayer);
  if (!optionalMapsAllowed()) showPrivacyPlaceholder();

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        createMap();
      }
    }, { rootMargin: '200px' });
    observer.observe(mapElement);
  } else {
    createMap();
  }

  return {
    updateData(nextData = {}) {
      dataState = {
        locations: nextData.locations || dataState.locations,
        warnings: nextData.warnings || [],
        community: nextData.community || [],
        warningSample: Boolean(nextData.warningSample),
        warningUnavailable: Boolean(nextData.warningUnavailable),
        communitySample: Boolean(nextData.communitySample)
      };
      renderLayer(requestedLayer);
    }
  };
}
