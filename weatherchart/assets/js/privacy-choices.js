const POLICY_VERSION = 1;
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

const SITE_CONFIG = Object.freeze({
  coolisle: Object.freeze({
    storageKey: 'coolisle.privacy.v1',
    policyUrl: 'cookies.html',
    name: 'Cool Isle'
  }),
  weatherchart: Object.freeze({
    storageKey: 'weatherchart.privacy.v1',
    policyUrl: 'cookies.html',
    name: 'WeatherChart UK'
  })
});

let memoryChoice = null;
let banner = null;
let returnFocus = null;
let initialised = false;

function configuredSite() {
  const explicit = document.documentElement.dataset.consentSite;
  if (SITE_CONFIG[explicit]) return explicit;
  return /(?:\/WeatherChartUK\/|\/weatherchart\/)/i.test(window.location.pathname)
    ? 'weatherchart'
    : 'coolisle';
}

export function createPrivacyRecord(optionalMaps, now = Date.now()) {
  const decidedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SIX_MONTHS_MS).toISOString();
  return { version: POLICY_VERSION, optionalMaps: Boolean(optionalMaps), decidedAt, expiresAt };
}

export function parsePrivacyRecord(value, now = Date.now()) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'decidedAt,expiresAt,optionalMaps,version') return null;
  if (parsed.version !== POLICY_VERSION || typeof parsed.optionalMaps !== 'boolean') return null;
  const decidedAt = Date.parse(parsed.decidedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(expiresAt)) return null;
  if (decidedAt > now || expiresAt <= now || expiresAt - decidedAt > SIX_MONTHS_MS) return null;
  return parsed;
}

export function readPrivacyChoice(storage, storageKey, now = Date.now()) {
  try {
    const raw = storage?.getItem(storageKey);
    if (!raw) return null;
    const parsed = parsePrivacyRecord(raw, now);
    if (!parsed) storage?.removeItem(storageKey);
    return parsed;
  } catch {
    return null;
  }
}

export function writePrivacyChoice(storage, storageKey, optionalMaps, now = Date.now()) {
  const record = createPrivacyRecord(optionalMaps, now);
  try {
    storage?.setItem(storageKey, JSON.stringify(record));
  } catch {
    // The in-memory decision still applies to this page when storage is blocked.
  }
  return record;
}

function currentConfig() {
  return SITE_CONFIG[configuredSite()];
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function currentChoice() {
  if (memoryChoice) return memoryChoice;
  const config = currentConfig();
  return readPrivacyChoice(browserStorage(), config.storageKey);
}

export function optionalMapsAllowed() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  return currentChoice()?.optionalMaps === true;
}

function setDocumentState(choice) {
  document.documentElement.dataset.privacyChoice = choice
    ? choice.optionalMaps ? 'optional-allowed' : 'optional-rejected'
    : 'undecided';
}

function make(tag, { className, text, attributes } = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes || {})) element.setAttribute(name, value);
  return element;
}

function focusMainHeading() {
  const heading = document.querySelector('h1');
  if (!heading) return;
  const hadTabindex = heading.hasAttribute('tabindex');
  if (!hadTabindex) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  if (!hadTabindex) heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
}

function dispatchChoice(choice) {
  setDocumentState(choice);
  window.dispatchEvent(new CustomEvent('privacychoicechange', {
    detail: { optionalMaps: choice.optionalMaps, decidedAt: choice.decidedAt }
  }));
}

function saveChoice(optionalMaps) {
  const config = currentConfig();
  memoryChoice = writePrivacyChoice(browserStorage(), config.storageKey, optionalMaps);
  dispatchChoice(memoryChoice);
  banner?.remove();
  banner = null;
  const target = returnFocus?.isConnected ? returnFocus : null;
  returnFocus = null;
  if (target) target.focus({ preventScroll: true });
  else focusMainHeading();
  const status = document.querySelector('[data-privacy-choice-status]');
  if (status) status.textContent = optionalMaps
    ? 'Privacy choice saved. Optional interactive maps are allowed.'
    : 'Privacy choice saved. Optional interactive maps remain off.';
}

function showBanner(opener = null) {
  if (banner) {
    banner.querySelector('button')?.focus();
    return;
  }
  returnFocus = opener;
  const config = currentConfig();
  banner = make('section', {
    className: 'privacy-choice',
    attributes: {
      role: 'region',
      'aria-labelledby': 'privacy-choice-title',
      'aria-describedby': 'privacy-choice-copy',
      'data-privacy-choice-panel': ''
    }
  });
  const copy = make('div', { className: 'privacy-choice__copy' });
  copy.append(
    make('p', { className: 'privacy-choice__eyebrow', text: 'Cookie and privacy choices' }),
    make('h2', { text: `Your choice on ${config.name}`, attributes: { id: 'privacy-choice-title' } }),
    make('p', {
      text: 'We use no analytics or advertising cookies. You can allow or reject the optional external interactive map. One necessary browser-storage record remembers your choice for six months.',
      attributes: { id: 'privacy-choice-copy' }
    })
  );
  const actions = make('div', { className: 'privacy-choice__actions' });
  const reject = make('button', {
    className: 'privacy-choice__button',
    text: 'Reject optional maps',
    attributes: { type: 'button', 'data-privacy-reject': '' }
  });
  const allow = make('button', {
    className: 'privacy-choice__button',
    text: 'Allow optional maps',
    attributes: { type: 'button', 'data-privacy-allow': '' }
  });
  const details = make('a', {
    className: 'privacy-choice__details',
    text: 'Read cookies and privacy choices',
    attributes: { href: config.policyUrl }
  });
  reject.addEventListener('click', () => saveChoice(false));
  allow.addEventListener('click', () => saveChoice(true));
  actions.append(reject, allow, details);
  banner.append(copy, actions);
  document.body.append(banner);
  if (opener) reject.focus();
}

export function clearPrivacyChoice() {
  const config = currentConfig();
  try {
    browserStorage()?.removeItem(config.storageKey);
  } catch {
    // A blocked storage API is already equivalent to no saved choice.
  }
  memoryChoice = null;
  setDocumentState(null);
  window.dispatchEvent(new CustomEvent('privacychoicechange', {
    detail: { optionalMaps: false, decidedAt: null }
  }));
}

export function initialisePrivacyChoices() {
  if (initialised || typeof window === 'undefined' || typeof document === 'undefined') return;
  initialised = true;
  const choice = currentChoice();
  setDocumentState(choice);
  if (choice) dispatchChoice(choice);
  else showBanner();

  document.addEventListener('click', (event) => {
    const settings = event.target.closest('[data-privacy-settings]');
    if (settings) {
      event.preventDefault();
      showBanner(settings);
      return;
    }
    const reset = event.target.closest('[data-privacy-reset]');
    if (reset) {
      event.preventDefault();
      clearPrivacyChoice();
      showBanner(reset);
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialisePrivacyChoices, { once: true });
  } else {
    initialisePrivacyChoices();
  }
}
