import {
  MET_OFFICE_PRODUCT_URL,
  MET_OFFICE_TERMS_URL,
  OPEN_METEO_TERMS_URL,
  OPEN_METEO_URL,
  WEATHERCHART_SCHEMA_VERSION,
} from "./constants.mjs";

const FIELD_ALIASES = {
  temperatureC: ["screenTemperature", "temperature", "airTemperature"],
  feelsLikeC: ["feelsLikeTemperature", "feelsLikeTemp", "apparentTemperature"],
  precipitationProbabilityPercent: ["probOfPrecipitation", "precipitationProbability"],
  precipitationMm: ["totalPrecipAmount", "totalPrecipitationAmount", "precipitationAmount"],
  precipitationRateMmPerHour: ["precipitationRate"],
  humidityPercent: ["screenRelativeHumidity", "relativeHumidity"],
  windSpeed: ["windSpeed10m", "windSpeed", "windSpeedAt10m"],
  windGust: ["windGustSpeed10m", "windGustSpeed", "windGust"],
  windDirectionDegrees: ["windDirectionFrom10m", "windDirection", "windDirection10m"],
  visibilityM: ["visibility", "visibilityAtScreenLevel"],
  pressure: ["mslp", "meanSeaLevelPressure"],
  weatherCode: ["significantWeatherCode", "weatherCode"],
  uvIndex: ["uvIndex"],
  cloudCoverPercent: ["totalCloudAmount", "cloudCover"],
  dewPointC: ["screenDewPointTemperature", "dewPointTemperature"],
};

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pick(record, aliases) {
  for (const alias of aliases) {
    if (record[alias] != null) return finiteNumber(record[alias]);
  }
  return null;
}

function round(value, digits = 1) {
  if (value == null) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parameterMetadata(payload) {
  const result = new Map();
  for (const entry of Array.isArray(payload?.parameters) ? payload.parameters : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const [key, details] of Object.entries(entry)) result.set(key, details);
  }
  return result;
}

function unitValue(metadata, aliases) {
  for (const alias of aliases) {
    const unit = metadata.get(alias)?.unit;
    const symbol = unit?.symbol?.value ?? unit?.symbol ?? unit?.label;
    if (typeof symbol === "string") return symbol.toLowerCase();
  }
  return "";
}

export function metresPerSecondToMph(value) {
  return value == null ? null : value * 2.2369362920544;
}

export function kilometresPerHourToMph(value) {
  return value == null ? null : value * 0.62137119223733;
}

function speedValues(value, unit) {
  if (value == null) return { mps: null, mph: null };
  if (unit.includes("mi") || unit === "mph") {
    return { mps: round(value / 2.2369362920544, 2), mph: round(value, 1) };
  }
  if (unit.includes("km") || unit.includes("km/h")) {
    return { mps: round(value / 3.6, 2), mph: round(kilometresPerHourToMph(value), 1) };
  }
  return { mps: round(value, 2), mph: round(metresPerSecondToMph(value), 1) };
}

function pressureHpa(value, unit) {
  if (value == null) return null;
  if (unit === "pa" || value > 2_000) return round(value / 100, 1);
  return round(value, 1);
}

export function conditionForCode(code) {
  const conditions = new Map([
    [0, "Clear night"], [1, "Sunny"], [2, "Partly cloudy"], [3, "Partly cloudy"],
    [5, "Mist"], [6, "Fog"], [7, "Cloudy"], [8, "Overcast"],
    [9, "Light rain shower"], [10, "Light rain shower"], [11, "Drizzle"], [12, "Light rain"],
    [13, "Heavy rain shower"], [14, "Heavy rain shower"], [15, "Heavy rain"],
    [16, "Sleet shower"], [17, "Sleet shower"], [18, "Sleet"],
    [19, "Hail shower"], [20, "Hail shower"], [21, "Hail"],
    [22, "Light snow shower"], [23, "Light snow shower"], [24, "Light snow"],
    [25, "Heavy snow shower"], [26, "Heavy snow shower"], [27, "Heavy snow"],
    [28, "Thunder shower"], [29, "Thunder shower"], [30, "Thunder"],
  ]);
  return conditions.get(Number(code)) ?? "Forecast available";
}

function ukDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function minFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

export function deriveDaily(hourly, { conditionForWeatherCode = conditionForCode } = {}) {
  const groups = new Map();
  for (const period of hourly) {
    const date = ukDateKey(period.time);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(period);
  }
  return [...groups.entries()].map(([date, periods]) => {
    const highC = round(maxFinite(periods.map(({ temperatureC }) => temperatureC)));
    const lowC = round(minFinite(periods.map(({ temperatureC }) => temperatureC)));
    const precipitationProbability = maxFinite(
      periods.map(({ precipitationProbabilityPercent }) => precipitationProbabilityPercent),
    );
    const precipitationValues = periods
      .map(({ precipitationMm }) => precipitationMm)
      .filter(Number.isFinite);
    const rainfallMm = precipitationValues.length
      ? round(precipitationValues.reduce((total, value) => total + value, 0), 2)
      : null;
    const maxWindSpeedMph = maxFinite(periods.map(({ windSpeedMph }) => windSpeedMph));
    const maxWindGustMph = maxFinite(periods.map(({ windGustMph }) => windGustMph));
    const maxWindKph = maxFinite(periods.map(({ windKph }) => windKph));
    const maxGustKph = maxFinite(periods.map(({ gustKph }) => gustKph));
    const weatherCode = periods.find(({ weatherCode }) => weatherCode != null)?.weatherCode ?? null;
    const condition = conditionForWeatherCode(weatherCode);
    return {
      date,
      derivedFrom: "hourly",
      condition,
      highC,
      lowC,
      highTemperatureC: highC,
      lowTemperatureC: lowC,
      precipitationProbability,
      maxPrecipitationProbabilityPercent: precipitationProbability,
      rainfallMm,
      precipitationMm: rainfallMm,
      windKph: maxWindKph,
      gustKph: maxGustKph,
      maxWindSpeedMph,
      maxWindGustMph,
      weatherCode,
      sunrise: null,
      sunset: null,
      summary: `${condition}; derived high ${highC ?? "—"}°C, low ${lowC ?? "—"}°C, with a ${precipitationProbability ?? "—"}% precipitation chance.`,
    };
  });
}

function normalisePeriod(entry, metadata) {
  if (!entry || typeof entry !== "object") throw new Error("A forecast time-series entry is invalid");
  const values = entry.data && typeof entry.data === "object" ? { ...entry.data, ...entry } : entry;
  const time = String(values.time ?? "");
  if (!Number.isFinite(Date.parse(time))) throw new Error("A forecast time-series entry has no valid time");
  const wind = speedValues(pick(values, FIELD_ALIASES.windSpeed), unitValue(metadata, FIELD_ALIASES.windSpeed));
  const gust = speedValues(pick(values, FIELD_ALIASES.windGust), unitValue(metadata, FIELD_ALIASES.windGust));
  const weatherCode = round(pick(values, FIELD_ALIASES.weatherCode), 0);
  const precipitationProbabilityPercent = round(pick(values, FIELD_ALIASES.precipitationProbabilityPercent), 0);
  const precipitationMm = round(pick(values, FIELD_ALIASES.precipitationMm), 2);
  const windKph = wind.mps == null ? null : round(wind.mps * 3.6, 1);
  const gustKph = gust.mps == null ? null : round(gust.mps * 3.6, 1);
  const visibilityM = pick(values, FIELD_ALIASES.visibilityM);
  return {
    time: new Date(time).toISOString(),
    temperatureC: round(pick(values, FIELD_ALIASES.temperatureC)),
    feelsLikeC: round(pick(values, FIELD_ALIASES.feelsLikeC)),
    precipitationProbabilityPercent,
    precipitationProbability: precipitationProbabilityPercent,
    precipitationMm,
    rainfallMm: precipitationMm,
    precipitationRateMmPerHour: round(pick(values, FIELD_ALIASES.precipitationRateMmPerHour), 2),
    humidityPercent: round(pick(values, FIELD_ALIASES.humidityPercent), 0),
    windSpeedMps: wind.mps,
    windSpeedMph: wind.mph,
    windKph,
    windGustMps: gust.mps,
    windGustMph: gust.mph,
    gustKph,
    windDirectionDegrees: round(pick(values, FIELD_ALIASES.windDirectionDegrees), 0),
    visibilityM: round(visibilityM, 0),
    visibilityKm: visibilityM == null ? null : round(visibilityM / 1_000, 1),
    pressureHpa: pressureHpa(pick(values, FIELD_ALIASES.pressure), unitValue(metadata, FIELD_ALIASES.pressure)),
    weatherCode,
    condition: conditionForCode(weatherCode),
    uvIndex: round(pick(values, FIELD_ALIASES.uvIndex), 1),
    cloudCoverPercent: round(pick(values, FIELD_ALIASES.cloudCoverPercent), 0),
    dewPointC: round(pick(values, FIELD_ALIASES.dewPointC), 1),
  };
}

function selectCurrent(hourly, now) {
  const period = hourly.find(({ time }) => Date.parse(time) >= now.getTime()) ?? hourly.at(-1) ?? null;
  return period ? { ...period, observedAt: period.time } : null;
}

export function normaliseMetOfficeForecast(payload, location, now = new Date()) {
  if (!payload || payload.type !== "FeatureCollection" || !Array.isArray(payload.features) || payload.features.length < 1) {
    throw new Error("Met Office response is not a GeoJSON FeatureCollection");
  }
  const feature = payload.features[0];
  const properties = feature?.properties;
  const timeSeries = Array.isArray(properties?.timeSeries)
    ? properties.timeSeries
    : properties?.timeSeries && typeof properties.timeSeries === "object"
      ? Object.values(properties.timeSeries)
      : null;
  if (!timeSeries?.length) throw new Error("Met Office response contains no hourly time series");
  const metadata = parameterMetadata(payload);
  const hourly = timeSeries
    .map((entry) => normalisePeriod(entry, metadata))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!hourly.some(({ temperatureC }) => temperatureC != null)) {
    throw new Error("Met Office response contains no usable temperature values");
  }
  const coordinates = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const modelRunDate = properties?.modelRunDate && Number.isFinite(Date.parse(properties.modelRunDate))
    ? new Date(properties.modelRunDate).toISOString()
    : null;
  return {
    id: location.id,
    name: location.name,
    region: location.region,
    latitude: location.latitude,
    longitude: location.longitude,
    sourcePoint: {
      longitude: finiteNumber(coordinates[0]),
      latitude: finiteNumber(coordinates[1]),
      elevationM: finiteNumber(coordinates[2]),
      distanceFromRequestedM: finiteNumber(properties?.requestPointDistance),
      name: typeof properties?.location?.name === "string" ? properties.location.name : null,
      licence: typeof properties?.location?.licence === "string" ? properties.location.licence : null,
      modelRunDate,
    },
    current: selectCurrent(hourly, now),
    hourly,
    daily: deriveDaily(hourly),
  };
}

export function buildOfficialForecast(locations, generatedAt = new Date()) {
  return {
    schemaVersion: WEATHERCHART_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    dataStatus: "live",
    datasetState: "live",
    sample: false,
    fallback: false,
    source: {
      id: "met-office-global-spot-hourly",
      name: "Met Office Weather DataHub",
      product: "Global Spot hourly",
      url: MET_OFFICE_PRODUCT_URL,
      termsUrl: MET_OFFICE_TERMS_URL,
      licence: "Met Office Weather DataHub product terms",
      label: "Live Met Office Global Spot hourly forecast",
      attribution: "Powered by Met Office data — data supplied by the Met Office.",
    },
    units: {
      temperature: "°C",
      precipitation: "mm",
      precipitationProbability: "%",
      windSpeed: "mph",
      visibility: "m",
      pressure: "hPa",
    },
    locations,
  };
}

export function buildOpenMeteoForecast(locations, generatedAt = new Date()) {
  return {
    schemaVersion: WEATHERCHART_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    dataStatus: "live-fallback",
    datasetState: "live-fallback",
    sample: false,
    fallback: true,
    source: {
      id: "open-meteo-forecast",
      name: "Open-Meteo",
      product: "Forecast API",
      url: OPEN_METEO_URL,
      termsUrl: OPEN_METEO_TERMS_URL,
      licence: "CC BY 4.0",
      label: "Live Open-Meteo indicative forecast",
      attribution: "Weather data by Open-Meteo.com.",
    },
    units: {
      temperature: "°C",
      precipitation: "mm",
      precipitationProbability: "%",
      windSpeed: "km/h",
      visibility: "m",
      pressure: "hPa",
    },
    locations,
  };
}

export function isOfficialForecast(forecast) {
  return forecast?.source?.id === "met-office-global-spot-hourly" && forecast?.sample === false;
}

export function isOpenMeteoForecast(forecast) {
  return forecast?.source?.id === "open-meteo-forecast" && forecast?.sample === false;
}

export function isLiveForecast(forecast) {
  return isOfficialForecast(forecast) || isOpenMeteoForecast(forecast);
}

export function officialForecastTimestamp(forecast, status) {
  const values = [status?.lastSuccessfulOfficialAt, isOfficialForecast(forecast) ? forecast.generatedAt : null]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

export function buildMockForecast(locations, now = new Date()) {
  const start = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const normalisedLocations = locations.map((location, locationIndex) => {
    const hourly = Array.from({ length: 48 }, (_, hourIndex) => {
      const time = new Date(start.getTime() + hourIndex * 3_600_000);
      const cycle = Math.sin(((hourIndex - 6) / 24) * Math.PI * 2);
      const temperatureC = round(11 + locationIndex * 0.25 + cycle * 4.5);
      const precipitationProbabilityPercent = Math.round(Math.max(5, 48 - cycle * 28 + (locationIndex % 3) * 4));
      const windSpeedMph = round(7 + (locationIndex % 5) + Math.abs(cycle) * 5);
      const windKph = round(windSpeedMph * 1.609344, 1);
      const weatherCode = precipitationProbabilityPercent > 60 ? 12 : cycle > 0.35 ? 3 : 7;
      return {
        time: time.toISOString(),
        temperatureC,
        feelsLikeC: round(temperatureC - 1.2),
        precipitationProbabilityPercent,
        precipitationProbability: precipitationProbabilityPercent,
        precipitationMm: precipitationProbabilityPercent > 60 ? 0.7 : 0,
        rainfallMm: precipitationProbabilityPercent > 60 ? 0.7 : 0,
        precipitationRateMmPerHour: precipitationProbabilityPercent > 60 ? 0.7 : 0,
        humidityPercent: Math.round(68 + Math.abs(cycle) * 16),
        windSpeedMps: round(windSpeedMph / 2.2369362920544, 2),
        windSpeedMph,
        windKph,
        windGustMps: round((windSpeedMph + 6) / 2.2369362920544, 2),
        windGustMph: round(windSpeedMph + 6),
        gustKph: round((windSpeedMph + 6) * 1.609344, 1),
        windDirectionDegrees: (210 + locationIndex * 9) % 360,
        visibilityM: 10_000,
        pressureHpa: 1013,
        weatherCode,
        condition: conditionForCode(weatherCode),
        uvIndex: cycle > 0 ? round(cycle * 4, 1) : 0,
        cloudCoverPercent: Math.round(55 + Math.abs(cycle) * 30),
        dewPointC: round(temperatureC - 3),
      };
    });
    return {
      ...location,
      sourcePoint: null,
      current: selectCurrent(hourly, now),
      hourly,
      daily: deriveDaily(hourly),
    };
  });
  return {
    schemaVersion: WEATHERCHART_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    dataStatus: "sample",
    datasetState: "sample",
    sample: true,
    fallback: true,
    source: {
      id: "weatherchart-sample",
      name: "WeatherChart UK demonstration data",
      url: null,
      termsUrl: null,
      licence: "Synthetic demonstration data",
      label: "SAMPLE DATA — not a live forecast",
      attribution: "Sample data — not a live forecast.",
    },
    units: {
      temperature: "°C",
      precipitation: "mm",
      precipitationProbability: "%",
      windSpeed: "mph",
      visibility: "m",
      pressure: "hPa",
    },
    locations: normalisedLocations,
  };
}
