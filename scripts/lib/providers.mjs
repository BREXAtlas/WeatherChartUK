import {
  MET_OFFICE_HOURLY_ENDPOINT,
  OPEN_METEO_FORECAST_ENDPOINT,
  REQUEST_TIMEOUT_MS,
} from "./constants.mjs";
import { safeErrorCode } from "./fs-json.mjs";
import { buildMockForecast, deriveDaily, normaliseMetOfficeForecast } from "./weather.mjs";

function providerError(message, code) {
  return Object.assign(new Error(message), { code });
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTime(value) {
  const raw = String(value || "");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function wmoCondition(code) {
  const value = Number(code);
  if (value === 0) return "Clear";
  if ([1, 2].includes(value)) return "Partly cloudy";
  if (value === 3) return "Overcast";
  if ([45, 48].includes(value)) return "Fog";
  if (value >= 51 && value <= 57) return "Drizzle";
  if (value >= 61 && value <= 67) return "Rain";
  if (value >= 71 && value <= 77) return "Snow";
  if (value >= 80 && value <= 82) return "Rain shower";
  if (value >= 85 && value <= 86) return "Snow shower";
  if (value >= 95) return "Thunder shower";
  return "Forecast available";
}

export class MetOfficeProvider {
  constructor({ apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.id = "met-office-global-spot-hourly";
    this.name = "Met Office Weather DataHub";
    this.mode = "live";
    this.apiKey = String(apiKey || "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async fetchLocation(location, now = new Date()) {
    if (!this.apiKey) throw providerError("Met Office credential is not configured", "credential-not-configured");
    const url = new URL(MET_OFFICE_HOURLY_ENDPOINT);
    url.searchParams.set("excludeParameterMetadata", "false");
    url.searchParams.set("includeLocationName", "true");
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", apikey: this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw providerError("Weather DataHub request failed", safeErrorCode(error));
    }
    if (!response?.ok) {
      const status = Number(response?.status);
      throw providerError(
        "Weather DataHub returned an error",
        Number.isInteger(status) ? `met-office-http-${status}` : "met-office-http-error",
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw providerError("Weather DataHub returned malformed JSON", "met-office-invalid-json");
    }
    return normaliseMetOfficeForecast(payload, location, now);
  }
}

export class OpenMeteoFallbackProvider {
  constructor({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, enabled = false } = {}) {
    this.id = "open-meteo-fallback";
    this.name = "Open-Meteo indicative fallback";
    this.mode = "indicative-fallback";
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.enabled = enabled;
  }

  async fetchLocation(location, now = new Date()) {
    if (!this.enabled) throw providerError("Open-Meteo fallback is disabled", "open-meteo-fallback-disabled");
    const url = new URL(OPEN_METEO_FORECAST_ENDPOINT);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set("hourly", [
      "temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation",
      "relative_humidity_2m", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
      "visibility", "pressure_msl", "weather_code", "cloud_cover", "dew_point_2m",
    ].join(","));
    url.searchParams.set("forecast_days", "3");
    url.searchParams.set("timezone", "GMT");

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw providerError("Open-Meteo fallback request failed", safeErrorCode(error));
    }
    if (!response?.ok) {
      const status = Number(response?.status);
      throw providerError("Open-Meteo fallback returned an error", Number.isInteger(status) ? `open-meteo-http-${status}` : "open-meteo-http-error");
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw providerError("Open-Meteo fallback returned malformed JSON", "open-meteo-invalid-json");
    }
    const hourly = payload?.hourly || {};
    if (!Array.isArray(hourly.time) || !hourly.time.length) {
      throw providerError("Open-Meteo fallback returned no hourly periods", "open-meteo-invalid-payload");
    }
    const periods = hourly.time.map((time, index) => {
      const timestamp = isoTime(time);
      if (!timestamp) throw providerError("Open-Meteo fallback returned an invalid timestamp", "open-meteo-invalid-payload");
      const visibilityM = finite(hourly.visibility?.[index]);
      const precipitationProbability = finite(hourly.precipitation_probability?.[index]);
      const rainfallMm = finite(hourly.precipitation?.[index]);
      const windKph = finite(hourly.wind_speed_10m?.[index]);
      const gustKph = finite(hourly.wind_gusts_10m?.[index]);
      const weatherCode = finite(hourly.weather_code?.[index]);
      return {
        time: timestamp,
        temperatureC: finite(hourly.temperature_2m?.[index]),
        feelsLikeC: finite(hourly.apparent_temperature?.[index]),
        precipitationProbability,
        precipitationProbabilityPercent: precipitationProbability,
        rainfallMm,
        precipitationMm: rainfallMm,
        humidityPercent: finite(hourly.relative_humidity_2m?.[index]),
        windKph,
        windSpeedMps: windKph === null ? null : Math.round((windKph / 3.6) * 100) / 100,
        windSpeedMph: windKph === null ? null : Math.round((windKph * 0.6213711922) * 10) / 10,
        gustKph,
        windGustMps: gustKph === null ? null : Math.round((gustKph / 3.6) * 100) / 100,
        windGustMph: gustKph === null ? null : Math.round((gustKph * 0.6213711922) * 10) / 10,
        windDirectionDegrees: finite(hourly.wind_direction_10m?.[index]),
        visibilityM,
        visibilityKm: visibilityM === null ? null : Math.round(visibilityM / 100) / 10,
        pressureHpa: finite(hourly.pressure_msl?.[index]),
        weatherCode,
        condition: wmoCondition(weatherCode),
        cloudCoverPercent: finite(hourly.cloud_cover?.[index]),
        dewPointC: finite(hourly.dew_point_2m?.[index]),
      };
    });
    const futurePeriods = periods.filter(({ time }) => Date.parse(time) >= now.getTime());
    const displayHourly = (futurePeriods.length ? futurePeriods : periods.slice(-24)).slice(0, 24);
    const current = displayHourly[0] ?? periods.at(-1);
    return {
      ...location,
      sourcePoint: { latitude: finite(payload.latitude), longitude: finite(payload.longitude), name: null },
      current: current ? { ...current, observedAt: current.time, sunrise: null, sunset: null } : null,
      hourly: displayHourly,
      // Daily summaries retain the complete three-day response even though the
      // public hourly payload contains only the next 24 useful periods.
      daily: deriveDaily(periods, { conditionForWeatherCode: wmoCondition }),
    };
  }
}

export class MockProvider {
  constructor() {
    this.id = "mock";
    this.name = "MockProvider";
    this.mode = "sample";
  }

  async fetchLocation(location, now = new Date()) {
    return buildMockForecast([location], now).locations[0];
  }

  async fetchAll(locations, now = new Date()) {
    return buildMockForecast(locations, now);
  }
}
