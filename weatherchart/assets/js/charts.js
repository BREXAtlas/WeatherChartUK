import { formatHour } from './config.js';
import { makeElement } from './accessibility.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement(name, attributes = {}, text = '') {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text) element.textContent = text;
  return element;
}

function valueOf(item, key) {
  if (item?.[key] === null || item?.[key] === undefined || item?.[key] === '') return null;
  const value = Number(item?.[key]);
  return Number.isFinite(value) ? value : null;
}

function linePath(data, key, xFor, yFor) {
  let drawing = false;
  return data.flatMap((item, index) => {
    const value = valueOf(item, key);
    if (value === null) {
      drawing = false;
      return [];
    }
    const command = drawing ? 'L' : 'M';
    drawing = true;
    return `${command} ${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`;
  }).join(' ');
}

function addPointSeries(group, data, key, xFor, yFor, className, label) {
  data.forEach((item, index) => {
    const value = valueOf(item, key);
    if (value === null) return;
    const point = svgElement('circle', {
      cx: xFor(index),
      cy: yFor(value),
      r: 4.6,
      class: `chart-point ${className}`,
      tabindex: 0,
      role: 'img',
      'aria-label': `${formatHour(item.time)}: ${label} ${Math.round(value)}${key.includes('temperature') || key === 'feelsLikeC' ? ' degrees Celsius' : ' kilometres per hour'}`
    });
    group.append(point);
  });
}

export function renderHourlyChart(location) {
  const svg = document.querySelector('[data-hourly-chart]');
  const table = document.querySelector('[data-hourly-table]');
  const tableLocation = document.querySelector('[data-table-location]');
  if (!svg || !table) return;
  const data = (location.hourly || []).slice(0, 24);
  svg.replaceChildren(
    svgElement('title', { id: 'chart-title' }, `Twenty-four-hour weather chart for ${location.name}`),
    svgElement('desc', { id: 'chart-desc' }, 'Temperature, feels-like temperature, precipitation probability, wind and gusts. Every chart point can receive keyboard focus, and the same information follows as a table.')
  );

  if (!data.length) {
    svg.append(svgElement('text', { x: 40, y: 70, class: 'chart-axis-label' }, 'No hourly forecast is available.'));
    table.replaceChildren();
    return;
  }

  const width = 1040;
  const left = 78;
  const right = 24;
  const plotWidth = width - left - right;
  const xFor = (index) => left + (plotWidth * index) / Math.max(1, data.length - 1);

  const temperatures = data
    .flatMap((item) => [valueOf(item, 'temperatureC'), valueOf(item, 'feelsLikeC')])
    .filter((value) => value !== null);
  if (!temperatures.length) temperatures.push(0);
  const tempMin = Math.floor(Math.min(...temperatures) - 2);
  const tempMax = Math.ceil(Math.max(...temperatures) + 2);
  const tempY = (value) => 138 - ((value - tempMin) / Math.max(1, tempMax - tempMin)) * 90;
  const rainY = (value) => 240 - (Math.max(0, Math.min(100, value)) / 100) * 70;
  const windValues = data
    .flatMap((item) => [valueOf(item, 'windKph'), valueOf(item, 'gustKph')])
    .filter((value) => value !== null);
  const maxWind = Math.max(20, ...windValues);
  const windY = (value) => 352 - (Math.max(0, value) / maxWind) * 65;

  const grid = svgElement('g', { 'aria-hidden': 'true' });
  [48, 93, 138, 170, 205, 240, 287, 320, 352].forEach((y) => {
    grid.append(svgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'chart-grid-line' }));
  });
  data.forEach((item, index) => {
    if (index % 3 !== 0 && index !== data.length - 1) return;
    const x = xFor(index);
    grid.append(svgElement('line', { x1: x, y1: 35, x2: x, y2: 352, class: 'chart-grid-line' }));
    grid.append(svgElement('text', { x, y: 380, class: 'chart-time-label', 'text-anchor': 'middle' }, formatHour(item.time)));
  });
  svg.append(grid);

  const labels = svgElement('g', { 'aria-hidden': 'true' });
  labels.append(
    svgElement('text', { x: 10, y: 45, class: 'chart-axis-label' }, 'Temp °C'),
    svgElement('text', { x: 10, y: 180, class: 'chart-axis-label' }, 'Rain %'),
    svgElement('text', { x: 10, y: 297, class: 'chart-axis-label' }, 'Wind'),
    svgElement('text', { x: 10, y: 315, class: 'chart-value-label' }, 'km/h'),
    svgElement('text', { x: left - 10, y: 52, class: 'chart-value-label', 'text-anchor': 'end' }, tempMax),
    svgElement('text', { x: left - 10, y: 140, class: 'chart-value-label', 'text-anchor': 'end' }, tempMin),
    svgElement('text', { x: left - 10, y: 174, class: 'chart-value-label', 'text-anchor': 'end' }, '100'),
    svgElement('text', { x: left - 10, y: 241, class: 'chart-value-label', 'text-anchor': 'end' }, '0'),
    svgElement('text', { x: left - 10, y: 292, class: 'chart-value-label', 'text-anchor': 'end' }, Math.ceil(maxWind)),
    svgElement('text', { x: left - 10, y: 353, class: 'chart-value-label', 'text-anchor': 'end' }, '0')
  );
  svg.append(labels);

  const rainBars = svgElement('g');
  const barWidth = Math.max(8, plotWidth / data.length - 5);
  data.forEach((item, index) => {
    const value = valueOf(item, 'precipitationProbability');
    if (value === null) return;
    const rainfall = valueOf(item, 'rainfallMm');
    const y = rainY(value);
    const bar = svgElement('rect', {
      x: xFor(index) - barWidth / 2,
      y,
      width: barWidth,
      height: 240 - y,
      rx: 3,
      class: 'chart-rain-bar',
      tabindex: 0,
      role: 'img',
      'aria-label': `${formatHour(item.time)}: precipitation probability ${Math.round(value)} percent${rainfall === null ? '; rainfall unavailable' : ` and rainfall ${rainfall.toFixed(1)} millimetres`}`
    });
    rainBars.append(bar);
  });
  svg.append(rainBars);

  const series = svgElement('g');
  series.append(
    svgElement('path', { d: linePath(data, 'temperatureC', xFor, tempY), class: 'chart-line chart-line--temperature', 'aria-hidden': 'true' }),
    svgElement('path', { d: linePath(data, 'feelsLikeC', xFor, tempY), class: 'chart-line chart-line--feels', 'aria-hidden': 'true' }),
    svgElement('path', { d: linePath(data, 'windKph', xFor, windY), class: 'chart-line chart-line--wind', 'aria-hidden': 'true' }),
    svgElement('path', { d: linePath(data, 'gustKph', xFor, windY), class: 'chart-line chart-line--gust', 'aria-hidden': 'true' })
  );
  addPointSeries(series, data, 'temperatureC', xFor, tempY, 'chart-point--temperature', 'temperature');
  addPointSeries(series, data, 'feelsLikeC', xFor, tempY, 'chart-point--feels', 'feels-like temperature');
  addPointSeries(series, data, 'windKph', xFor, windY, 'chart-point--wind', 'wind');
  addPointSeries(series, data, 'gustKph', xFor, windY, 'chart-point--gust', 'gusts');
  svg.append(series);

  table.replaceChildren();
  if (tableLocation) tableLocation.textContent = location.name;
  const caption = table.closest('table')?.querySelector('caption');
  if (caption?.hasAttribute('data-hourly-caption')) {
    caption.firstChild.textContent = 'Hourly forecast for ';
  }
  data.forEach((item) => {
    const row = document.createElement('tr');
    const time = makeElement('th', { text: formatHour(item.time), attributes: { scope: 'row' } });
    row.append(time);
    const display = (key, formatter) => {
      const value = valueOf(item, key);
      return value === null ? 'Unavailable' : formatter(value);
    };
    [
      item.condition || '—',
      display('temperatureC', (value) => `${Math.round(value)}°C`),
      display('feelsLikeC', (value) => `${Math.round(value)}°C`),
      display('precipitationProbability', (value) => `${Math.round(value)}%`),
      display('rainfallMm', (value) => `${value.toFixed(1)} mm`),
      display('windKph', (value) => `${Math.round(value)} km/h`),
      display('gustKph', (value) => `${Math.round(value)} km/h`)
    ].forEach((value) => row.append(makeElement('td', { text: value })));
    table.append(row);
  });
}
