import { formatUkDateTime } from './config.js';
import { announce, makeElement, safeExternalLink, setBusy } from './accessibility.js';

const severityRank = { red: 3, amber: 2, yellow: 1 };
let lastAnnouncementSignature = '';

export function hasSeriousLiveWarning(data) {
  if (!data || data.sample) return false;
  return (data.warnings || []).some((warning) => ['red', 'amber'].includes(String(warning.severity).toLowerCase()));
}

function announceWarningChange(data, warnings) {
  if (data?.sample) return;
  if (data?.unavailable) {
    const signature = `unavailable:${data?.generatedAt || 'unknown'}`;
    if (signature !== lastAnnouncementSignature) {
      announce('Warning data could not be refreshed. Check the current official Met Office warning service now.', 'error');
      lastAnnouncementSignature = signature;
    }
    return;
  }
  const serious = warnings.filter((warning) => ['red', 'amber'].includes(String(warning.severity).toLowerCase()));
  if (!serious.length) {
    lastAnnouncementSignature = '';
    return;
  }
  const signature = serious
    .map((warning) => `${warning.id}:${warning.severity}:${warning.validUntil}`)
    .sort()
    .join('|');
  if (signature === lastAnnouncementSignature) return;
  const levels = [...new Set(serious.map((warning) => String(warning.severity).toUpperCase()))].join(' and ');
  announce(`${serious.length} active ${levels} warning ${serious.length === 1 ? 'item requires' : 'items require'} attention. Read and follow the full official warning details.`, 'error');
  lastAnnouncementSignature = signature;
}

export function renderWarnings(data) {
  const container = document.querySelector('[data-warning-list]');
  if (!container) return;
  setBusy(container, true);
  container.replaceChildren();
  const warnings = [...(data?.warnings || [])].sort((a, b) =>
    (severityRank[String(b.severity).toLowerCase()] || 0) - (severityRank[String(a.severity).toLowerCase()] || 0)
  );
  announceWarningChange(data, warnings);

  if (!warnings.length) {
    const empty = makeElement('div', { className: 'empty-state' });
    empty.append(
      makeElement('h3', { text: data?.unavailable ? 'Warning data is unavailable' : 'No warning cards in this dataset' }),
      makeElement('p', { text: data?.unavailable ? 'The warning source could not be refreshed. Do not infer that there are no active warnings.' : 'That is not a declaration that the UK has no warnings. Check the current official warning service.' })
    );
    const link = makeElement('a', { text: 'Check official Met Office warnings', attributes: { href: 'https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings', rel: 'external noopener' } });
    const legend = makeElement('ul', { className: 'severity-legend', attributes: { 'aria-label': 'Weather warning severity levels' } });
    ['Yellow', 'Amber', 'Red'].forEach((severity) => {
      const item = makeElement('li');
      item.append(
        makeElement('span', { className: `severity-badge severity-badge--${severity.toLowerCase()}`, text: severity }),
        document.createTextNode(`${severity} warning severity`)
      );
      legend.append(item);
    });
    empty.append(legend, link);
    container.append(empty);
    setBusy(container, false);
    return;
  }

  warnings.forEach((warning) => {
    const severity = String(warning.severity || 'yellow').toLowerCase();
    const label = severity.charAt(0).toUpperCase() + severity.slice(1);
    const card = makeElement('article', { className: 'warning-card', attributes: { 'data-severity': label } });
    const top = makeElement('div', { className: 'warning-card__topline' });
    top.append(
      makeElement('span', { className: 'severity-badge', text: `${label} warning` }),
      makeElement('span', { className: 'sample-badge', text: data.sample ? 'Illustrative only' : data.preserved || data.unavailable ? 'Preserved — verify now' : 'Official feed' })
    );
    const title = makeElement('h3', { text: warning.title || `${label} weather warning` });
    const description = makeElement('p', { text: warning.description || 'Read the official source for full warning details.' });
    const timing = makeElement('div', { className: 'warning-card__timing' });
    [['Valid from', warning.validFrom], ['Valid until', warning.validUntil]].forEach(([term, value]) => {
      const group = makeElement('span');
      group.append(
        makeElement('span', { text: term }),
        makeElement('strong', { text: formatUkDateTime(value) })
      );
      timing.append(group);
    });
    const regions = makeElement('p', { className: 'warning-card__regions' });
    const regionText = Array.isArray(warning.regions) && warning.regions.length
      ? warning.regions.join(', ')
      : 'See the official source for affected areas';
    regions.append(
      makeElement('strong', { text: 'Affected regions: ' }),
      document.createTextNode(regionText)
    );
    const interpretation = makeElement('p', { className: 'warning-card__interpretation' });
    interpretation.append(
      makeElement('strong', { text: "WeatherChart’s plain-English interpretation" }),
      document.createTextNode(warning.interpretation || 'Read the official warning for actions and full details.')
    );
    card.append(top, title, description, timing, regions, interpretation);
    const url = safeExternalLink(warning.sourceUrl);
    if (url) {
      card.append(makeElement('a', {
        text: data.sample ? 'Open the current official warnings page ↗' : 'Read the full official warning ↗',
        attributes: { href: url, rel: 'external noopener' }
      }));
    }
    container.append(card);
  });
  setBusy(container, false);
}
