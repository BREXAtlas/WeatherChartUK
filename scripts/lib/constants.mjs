import path from "node:path";

export const WEATHERCHART_SCHEMA_VERSION = 1;
export const DAILY_ATTEMPT_LIMIT = 350;
// Accepted only while migrating an already-audited durable record. Every new
// write uses DAILY_ATTEMPT_LIMIT, so the legacy value disappears naturally.
export const LEGACY_DAILY_ATTEMPT_LIMIT = 300;
export const REQUIRED_BATCH_SIZE = 12;
export const FRESHNESS_WINDOW_MS = 55 * 60 * 1000;
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const STRONGLY_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;
// A full sequential batch cannot start close enough to midnight to have requests
// accounted against a UTC day other than the one that was durably reserved.
export const UTC_BOUNDARY_GUARD_MS = 5 * 60 * 1000;

export const MET_OFFICE_HOURLY_ENDPOINT =
  "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly";
export const MET_OFFICE_PRODUCT_URL =
  "https://datahub.metoffice.gov.uk/docs/f/category/site-specific/overview";
export const MET_OFFICE_TERMS_URL =
  "https://www.metoffice.gov.uk/binaries/content/assets/metofficegovuk/pdf/data/met-office-weatherdatahub-terms-and-conditions.pdf";
export const MET_OFFICE_WARNINGS_RSS =
  "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK";
export const MET_OFFICE_NEWS_RSS =
  "https://www.metoffice.gov.uk/feed/syndication/news-rss.xml";
export const OPEN_METEO_FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_URL = "https://open-meteo.com/";
export const OPEN_METEO_TERMS_URL = "https://open-meteo.com/en/terms";

export const DATA_FILE_NAMES = [
  "forecast.json",
  "warnings.json",
  "news.json",
  "community.json",
  "status.json",
];

export const DEFAULT_LOCATIONS = Object.freeze([
  { id: "london", name: "London", region: "England", latitude: 51.5074, longitude: -0.1278 },
  { id: "birmingham", name: "Birmingham", region: "England", latitude: 52.4862, longitude: -1.8904 },
  { id: "manchester", name: "Manchester", region: "England", latitude: 53.4808, longitude: -2.2426 },
  { id: "glasgow", name: "Glasgow", region: "Scotland", latitude: 55.8642, longitude: -4.2518 },
  { id: "edinburgh", name: "Edinburgh", region: "Scotland", latitude: 55.9533, longitude: -3.1883 },
  { id: "cardiff", name: "Cardiff", region: "Wales", latitude: 51.4816, longitude: -3.1791 },
  { id: "belfast", name: "Belfast", region: "Northern Ireland", latitude: 54.5973, longitude: -5.9301 },
  { id: "bristol", name: "Bristol", region: "England", latitude: 51.4545, longitude: -2.5879 },
  { id: "newcastle", name: "Newcastle upon Tyne", region: "England", latitude: 54.9783, longitude: -1.6178 },
  { id: "leeds", name: "Leeds", region: "England", latitude: 53.8008, longitude: -1.5491 },
  { id: "plymouth", name: "Plymouth", region: "England", latitude: 50.3755, longitude: -4.1427 },
  { id: "norwich", name: "Norwich", region: "England", latitude: 52.6309, longitude: 1.2974 },
]);

export function createPaths(rootDir = process.cwd()) {
  const weatherchartDir = path.join(rootDir, "weatherchart");
  const dataDir = path.join(weatherchartDir, "data");
  const stateDir = path.join(rootDir, ".weatherchart-state");
  return {
    rootDir,
    weatherchartDir,
    dataDir,
    configDir: path.join(weatherchartDir, "config"),
    stateDir,
    lastValidDir: path.join(stateDir, "last-valid"),
    forecastPath: path.join(dataDir, "forecast.json"),
    warningsPath: path.join(dataDir, "warnings.json"),
    newsPath: path.join(dataDir, "news.json"),
    communityPath: path.join(dataDir, "community.json"),
    statusPath: path.join(dataDir, "status.json"),
    locationsPath: path.join(weatherchartDir, "config", "locations.json"),
    curatedNewsPath: path.join(weatherchartDir, "config", "curated-news.json"),
    curatedTikTokPath: path.join(weatherchartDir, "config", "curated-tiktok.json"),
    socialKeywordsPath: path.join(weatherchartDir, "config", "social-keywords.json"),
    socialAllowlistPath: path.join(weatherchartDir, "config", "social-allowlist.json"),
    socialBlocklistPath: path.join(weatherchartDir, "config", "social-blocklist.json"),
    sampleForecastPath: path.join(dataDir, "sample", "forecast.json"),
    quotaLedgerPath: path.join(stateDir, "quota-ledger.json"),
  };
}
