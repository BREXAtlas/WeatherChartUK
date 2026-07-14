import { makeElement } from './accessibility.js';

const geocodeCache = new Map();

function normalise(value) {
  return String(value || '').trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
}

function compactPostcode(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

function isFullPostcode(value) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compactPostcode(value));
}

function isOutwardCode(value) {
  return /^[A-Z]{1,2}\d[A-Z\d]?$/.test(compactPostcode(value));
}

function findTextMatch(locations, query) {
  const value = normalise(query);
  if (!value) return null;
  const aliases = { 'newcastle upon tyne': 'newcastle', 'greater manchester': 'manchester' };
  const alias = aliases[value];
  return locations.find((location) => location.id === alias)
    || locations.find((location) => normalise(location.name) === value)
    || locations.find((location) => normalise(location.id) === value)
    || locations.find((location) => normalise(location.name).startsWith(value));
}

function haversineKm(latitude1, longitude1, latitude2, longitude2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = radians(longitude2 - longitude1);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearestLocation(locations, latitude, longitude) {
  return locations.reduce((nearest, location) => {
    const distance = haversineKm(latitude, longitude, Number(location.latitude), Number(location.longitude));
    return !nearest || distance < nearest.distance ? { location, distance } : nearest;
  }, null);
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`Geocoder returned HTTP ${response?.status || 'error'}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function validCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

export async function geocodeUkQuery(query, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const key = normalise(query);
  if (key.length < 2) throw new Error('Enter at least two characters.');
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  let result;
  if (isFullPostcode(query) || isOutwardCode(query)) {
    const postcode = compactPostcode(query);
    const type = isFullPostcode(query) ? 'postcodes' : 'outcodes';
    const payload = await fetchJson(`https://api.postcodes.io/${type}/${encodeURIComponent(postcode)}`, fetchImpl, timeoutMs);
    const record = payload?.result;
    const latitude = validCoordinate(record?.latitude, -90, 90);
    const longitude = validCoordinate(record?.longitude, -180, 180);
    if (latitude === null || longitude === null) throw new Error('That postcode has no usable coordinate.');
    result = {
      name: String(record.admin_district || record.region || record.outcode || 'UK postcode area'),
      latitude,
      longitude,
      sourceName: 'postcodes.io',
      sourceUrl: 'https://postcodes.io/'
    };
  } else {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query.trim());
    url.searchParams.set('count', '5');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    url.searchParams.set('countryCode', 'GB');
    const payload = await fetchJson(url, fetchImpl, timeoutMs);
    const record = (payload?.results || []).find((candidate) => candidate?.country_code === 'GB');
    const latitude = validCoordinate(record?.latitude, -90, 90);
    const longitude = validCoordinate(record?.longitude, -180, 180);
    if (!record || latitude === null || longitude === null) throw new Error('No UK place matched that search.');
    result = {
      name: [record.name, record.admin1].filter(Boolean).join(', '),
      latitude,
      longitude,
      sourceName: 'Open-Meteo geocoding',
      sourceUrl: 'https://open-meteo.com/en/docs/geocoding-api'
    };
  }

  geocodeCache.set(key, result);
  return result;
}

export function initialiseLocationSearch(initialLocations, initialOnSelect, initialOptions = {}) {
  const form = document.querySelector('[data-location-search]');
  const input = document.querySelector('[data-location-input]');
  const list = document.querySelector('[data-location-suggestions]');
  const message = document.querySelector('[data-search-message]');
  const locationButton = document.querySelector('[data-use-location]');
  const submitButton = form?.querySelector('button[type="submit"]');
  if (!form || !input || !list) return { select: initialOnSelect, update() {} };

  let locations = initialLocations;
  let onSelect = initialOnSelect;
  let suggestions = [];
  let activeIndex = -1;

  const announce = (text) => {
    if (message) message.textContent = text;
  };

  const updateModeCopy = () => {
    const help = document.querySelector('[data-search-help]');
    const privacyCopy = document.querySelector('[data-location-privacy-copy]');
    if (help) {
      help.textContent = `Searches ${locations.length} configured forecast points first. Uncached UK places use Open-Meteo geocoding and postcodes use postcodes.io; results stay only in this tab's memory.`;
    }
    if (privacyCopy) {
      privacyCopy.textContent = 'We ask only after you choose this button, find the nearest available forecast point in your browser, then discard your coordinates.';
    }
  };

  const closeList = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  };

  const choose = (location, explanation) => {
    if (!location) return;
    input.value = location.name;
    closeList();
    announce(explanation || `Showing the available forecast point for ${location.name}.`);
    const url = new URL(window.location.href);
    url.searchParams.set('location', location.id);
    window.history.replaceState({ location: location.id }, '', url);
    onSelect(location);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelector('#local-weather')?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  const setActive = (nextIndex) => {
    if (!suggestions.length) return;
    activeIndex = (nextIndex + suggestions.length) % suggestions.length;
    [...list.children].forEach((item, index) => {
      const selected = index === activeIndex;
      item.setAttribute('aria-selected', String(selected));
      if (selected) {
        input.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const renderSuggestions = () => {
    const value = normalise(input.value);
    suggestions = locations.filter((location) =>
      !value || [location.name, location.region, location.id].some((field) => normalise(field).includes(value))
    ).slice(0, 8);
    list.replaceChildren();
    suggestions.forEach((location, index) => {
      const item = makeElement('li', {
        attributes: { id: `location-option-${index}`, role: 'option', 'aria-selected': 'false' }
      });
      item.append(
        makeElement('strong', { text: location.name }),
        makeElement('small', { text: `${location.region} · configured forecast point` })
      );
      item.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        choose(location);
      });
      list.append(item);
    });
    list.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(suggestions.length > 0));
    activeIndex = -1;
  };

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('blur', () => window.setTimeout(closeList, 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (list.hidden) renderSuggestions();
      setActive(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      choose(suggestions[activeIndex]);
    } else if (event.key === 'Escape') {
      closeList();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      announce('Enter a UK town, city, county or postcode.');
      input.focus();
      return;
    }

    const textMatch = findTextMatch(locations, query);
    if (textMatch) {
      choose(textMatch);
      return;
    }

    submitButton?.setAttribute('aria-busy', 'true');
    if (submitButton) submitButton.disabled = true;
    announce('Looking up that UK place without storing the query...');
    try {
      const geocoded = await geocodeUkQuery(query);
      const nearest = nearestLocation(locations, geocoded.latitude, geocoded.longitude);
      if (!nearest) throw new Error('No configured forecast point is available.');
      const distance = nearest.distance < 1 ? 'under 1 km' : `about ${Math.round(nearest.distance)} km`;
      choose(
        nearest.location,
        `${geocoded.sourceName} matched ${geocoded.name}. The nearest configured forecast point is ${nearest.location.name}, ${distance} away. This is not a street-level forecast; the result is not persisted.`
      );
    } catch {
      announce('That place could not be resolved safely. Try a full UK postcode or one of the 12 listed cities. Nothing was stored.');
      input.focus();
    } finally {
      submitButton?.removeAttribute('aria-busy');
      if (submitButton) submitButton.disabled = false;
    }
  });

  locationButton?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      announce('This browser does not offer location access. Search for a city instead.');
      return;
    }
    locationButton.disabled = true;
    announce('Waiting for your browser’s location choice…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nearest = nearestLocation(locations, coords.latitude, coords.longitude);
        locationButton.disabled = false;
        if (!nearest) {
          announce('No cached location could be selected. Your coordinates were not stored.');
          return;
        }
        choose(nearest.location, `Nearest of the ${locations.length} available forecast points: ${nearest.location.name}, about ${Math.round(nearest.distance)} km away. Your coordinates were discarded.`);
      },
      (error) => {
        locationButton.disabled = false;
        const reason = error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be read.';
        announce(`${reason} Nothing was stored; search for a city instead.`);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
    );
  });

  updateModeCopy();
  return {
    choose,
    closeList,
    update(nextLocations, nextOnSelect, nextOptions = {}) {
      if (Array.isArray(nextLocations) && nextLocations.length) locations = nextLocations;
      if (typeof nextOnSelect === 'function') onSelect = nextOnSelect;
      updateModeCopy();
      closeList();
    }
  };
}
