import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DAILY_ATTEMPT_LIMIT,
  DATA_FILE_NAMES,
  DEFAULT_LOCATIONS,
  LEGACY_DAILY_ATTEMPT_LIMIT,
  REQUIRED_BATCH_SIZE,
  createPaths,
} from "./lib/constants.mjs";
import { copyFileAtomic, isIsoDate, readJson, safeErrorCode, writeJsonAtomic } from "./lib/fs-json.mjs";
import { sanitisePublicUrl } from "./lib/community.mjs";
import { isDirectMetOfficeUrl, wordCount } from "./lib/rss.mjs";

const EXPECTED_IDS = new Set(DEFAULT_LOCATIONS.map(({ id }) => id));
const FORBIDDEN_KEY = /^(?:api[_-]?key|authorization|secret|bearer[_-]?token)$/i;

function isFiniteValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function validateOptionalRange(value, minimum, maximum, label, errors) {
  if (value === null || value === undefined || value === "") return;
  if (!isFiniteValue(value) || Number(value) < minimum || Number(value) > maximum) {
    errors.push(`${label} is outside its valid numeric range`);
  }
}

function checkNoSecrets(value, errors, trail = "data") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNoSecrets(item, errors, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^https?:/i.test(value)) {
      try {
        const url = new URL(value);
        for (const key of url.searchParams.keys()) {
          if (FORBIDDEN_KEY.test(key)) errors.push(`${trail} contains a credential query parameter`);
        }
      } catch {
        errors.push(`${trail} contains a malformed URL`);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) errors.push(`${trail}.${key} is a forbidden credential field`);
    checkNoSecrets(child, errors, `${trail}.${key}`);
  }
}

function validateForecast(forecast, errors) {
  if (!forecast || typeof forecast !== "object") return errors.push("forecast.json is not an object");
  if (!isIsoDate(forecast.generatedAt)) errors.push("forecast.json generatedAt is invalid");
  if (typeof forecast.sample !== "boolean") errors.push("forecast.json must identify sample state");
  if (!forecast.source || typeof forecast.source.name !== "string") errors.push("forecast.json source metadata is missing");
  if (!Array.isArray(forecast.locations) || forecast.locations.length !== REQUIRED_BATCH_SIZE) {
    errors.push(`forecast.json must contain exactly ${REQUIRED_BATCH_SIZE} locations`);
    return;
  }
  const ids = new Set();
  for (const location of forecast.locations) {
    if (!EXPECTED_IDS.has(location?.id)) errors.push(`forecast.json has unexpected location ${location?.id ?? "(missing)"}`);
    if (ids.has(location?.id)) errors.push(`forecast.json repeats location ${location?.id}`);
    ids.add(location?.id);
    if (!isFiniteValue(location?.latitude) || !isFiniteValue(location?.longitude)) {
      errors.push(`forecast location ${location?.id} has invalid coordinates`);
    }
    if (!location?.current || !Array.isArray(location?.hourly) || location.hourly.length < 1) {
      errors.push(`forecast location ${location?.id} has no usable hourly forecast`);
    }
    for (const period of location?.hourly ?? []) {
      if (!isIsoDate(period?.time)) errors.push(`forecast location ${location?.id} contains an invalid hourly timestamp`);
      if (!isFiniteValue(period?.temperatureC)) errors.push(`forecast location ${location?.id} contains an invalid temperature`);
      validateOptionalRange(period?.temperatureC, -100, 70, `forecast location ${location?.id} temperature`, errors);
      validateOptionalRange(period?.feelsLikeC, -100, 70, `forecast location ${location?.id} feels-like temperature`, errors);
      validateOptionalRange(period?.precipitationProbability, 0, 100, `forecast location ${location?.id} precipitation probability`, errors);
      validateOptionalRange(period?.rainfallMm, 0, 1_000, `forecast location ${location?.id} rainfall`, errors);
      validateOptionalRange(period?.humidityPercent, 0, 100, `forecast location ${location?.id} humidity`, errors);
      validateOptionalRange(period?.windKph, 0, 500, `forecast location ${location?.id} wind speed`, errors);
      validateOptionalRange(period?.gustKph, 0, 500, `forecast location ${location?.id} gust speed`, errors);
      validateOptionalRange(period?.visibilityKm, 0, 1_000, `forecast location ${location?.id} visibility`, errors);
      validateOptionalRange(period?.cloudCoverPercent, 0, 100, `forecast location ${location?.id} cloud cover`, errors);
    }
  }
  if (ids.size !== REQUIRED_BATCH_SIZE) errors.push("forecast.json location ids are incomplete");
  if (
    forecast.sample === false &&
    !["met-office-global-spot-hourly", "open-meteo-forecast"].includes(forecast.source?.id)
  ) {
    errors.push("A live forecast must identify an approved live provider");
  }
  if (forecast.source?.id === "open-meteo-forecast") {
    if (forecast.fallback !== true || !/open-meteo/i.test(forecast.source?.name ?? "")) {
      errors.push("An Open-Meteo forecast must be explicitly labelled as fallback data");
    }
    if (!/^https:\/\/open-meteo\.com\//i.test(forecast.source?.url ?? "")) {
      errors.push("An Open-Meteo forecast must link to its provider");
    }
  }
}

function validateWarnings(warnings, errors) {
  if (!warnings || typeof warnings !== "object" || !Array.isArray(warnings.warnings)) {
    return errors.push("warnings.json must contain a warnings array");
  }
  if (!isIsoDate(warnings.generatedAt)) errors.push("warnings.json generatedAt is invalid");
  if (warnings.omittedIncompleteCount && warnings.sample === false) {
    errors.push("warnings.json cannot publish a partially parsed live warning feed");
  }
  for (const warning of warnings.warnings) {
    if (!warning?.id || !warning?.title) errors.push("warnings.json contains an incomplete warning");
    if (!isDirectMetOfficeUrl(warning?.sourceUrl)) errors.push(`Warning ${warning?.id ?? "(unknown)"} lacks a direct Met Office link`);
    if (!["red", "amber", "yellow", "unknown"].includes(warning?.severity)) {
      errors.push(`Warning ${warning?.id ?? "(unknown)"} has an invalid severity`);
    }
    if (warnings.sample === false) {
      if (!["red", "amber", "yellow"].includes(warning?.severity)) {
        errors.push(`Live warning ${warning?.id ?? "(unknown)"} lacks a recognised severity`);
      }
      if (!isIsoDate(warning?.validFrom) || !isIsoDate(warning?.validUntil)
        || Date.parse(warning.validUntil) <= Date.parse(warning.validFrom)) {
        errors.push(`Live warning ${warning?.id ?? "(unknown)"} lacks a valid time window`);
      }
      const hasRegions = Array.isArray(warning?.regions) && warning.regions.some((value) => String(value).trim());
      const hasGeometry = warning?.geometry
        && ["Polygon", "MultiPolygon"].includes(warning.geometry.type)
        && Array.isArray(warning.geometry.coordinates)
        && warning.geometry.coordinates.length > 0;
      if (!hasRegions && !hasGeometry) {
        errors.push(`Live warning ${warning?.id ?? "(unknown)"} lacks an affected region or geometry`);
      }
    }
  }
}

function validateNews(news, errors) {
  if (!news || typeof news !== "object" || !Array.isArray(news.items)) {
    return errors.push("news.json must contain an items array");
  }
  if (!isIsoDate(news.generatedAt)) errors.push("news.json generatedAt is invalid");
  for (const item of news.items) {
    if (!item?.id || !item?.title) errors.push("news.json contains an incomplete item");
    if (!isDirectMetOfficeUrl(item?.url)) errors.push(`News item ${item?.id ?? "(unknown)"} lacks a direct Met Office link`);
    const words = wordCount(item?.summary);
    if (words < 8 || words > 25) errors.push(`News item ${item?.id ?? "(unknown)"} summary must contain 8–25 words`);
  }
}

function validateCommunity(community, errors) {
  if (!community || typeof community !== "object" || !Array.isArray(community.items)) {
    return errors.push("community.json must contain an items array");
  }
  if (!isIsoDate(community.generatedAt)) errors.push("community.json generatedAt is invalid");
  if (community.sample !== false) errors.push("community.json must never publish sample community posts");
  if (!["live-public-posts", "preserved-live", "no-current-posts"].includes(community.datasetState)) {
    errors.push("community.json has an invalid live dataset state");
  }
  if (community?.source?.scrapingUsed !== false) errors.push("community.json must confirm that page scraping is not used");
  if (community.audit) {
    if (community.audit.containsPostText !== false) errors.push("community.json audit must declare that it contains no post text");
    for (const [reason, count] of Object.entries(community.audit.excluded ?? {})) {
      if (!/^[a-z0-9-]{1,48}$/.test(reason) || !Number.isInteger(count) || count < 0) {
        errors.push("community.json audit contains an invalid exclusion counter");
        break;
      }
    }
  }
  const allowedStatuses = new Set(["approved", "manually-approved", "automated-filtered"]);
  const allowedMediaTypes = new Set(["text-link", "video-link", "oembed-link"]);
  const allowedLocationBases = new Set([
    "platform_geotag",
    "author_explicit",
    "keyword_only",
    "unknown",
  ]);
  for (const item of community.items) {
    const safeSource = sanitisePublicUrl(item?.url);
    if (!safeSource) errors.push(`Community item ${item?.id ?? "(unknown)"} is not on an allowed platform host`);
    else if (safeSource.platform !== item?.platform) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} platform does not match its source host`);
    }
    if (item?.familySafe !== true) errors.push(`Community item ${item?.id ?? "(unknown)"} is not marked family-safe`);
    if (!allowedStatuses.has(item?.reviewStatus)) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid review status`);
    }
    if (!allowedMediaTypes.has(item?.mediaType)) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid media type`);
    }
    if (!item?.id || !item?.title || !item?.author || !item?.excerpt || !item?.sourceName || !item?.sourceHost) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} is incomplete`);
    }
    if (safeSource && item?.sourceHost !== new URL(safeSource.url).hostname.toLowerCase()) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} source host does not match its direct link`);
    }
    if (!isIsoDate(item?.publishedAt)) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid publication date`);
    }
    if (!item?.location || typeof item.location !== "object" || !item.location.label) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} lacks a coarse location label`);
    } else {
      if (!allowedLocationBases.has(item.location.basis)) {
        errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid location basis`);
      }
      if (!["high", "medium", "low"].includes(item.location.confidence)) {
        errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid location confidence`);
      }
    }
    if (item?.location?.latitude != null || item?.location?.longitude != null) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} exposes precise coordinates`);
    }
    if (!item?.expiresAt || !isIsoDate(item.expiresAt)) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} has an invalid expiry`);
    } else if (
      isIsoDate(item?.publishedAt) &&
      (Date.parse(item.expiresAt) <= Date.parse(item.publishedAt)
        || Date.parse(item.expiresAt) - Date.parse(item.publishedAt) > 48 * 60 * 60 * 1_000)
    ) {
      errors.push(`Community item ${item?.id ?? "(unknown)"} has an expiry outside the 48-hour retention window`);
    }
  }
}

function validateQuota(quota, errors) {
  if (!quota || typeof quota !== "object") return errors.push("status.json quota metadata is missing");
  const day = quota.utcDay ?? quota.quotaDayUtc;
  const limit = quota.limit ?? quota.limitPerUtcDay;
  const attempts = quota.attempts ?? quota.callsUsed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) errors.push("status.json quota UTC day is invalid");
  if (limit !== DAILY_ATTEMPT_LIMIT) {
    errors.push(`status.json quota must enforce a ${DAILY_ATTEMPT_LIMIT}-attempt limit`);
  }
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > DAILY_ATTEMPT_LIMIT) {
    errors.push("status.json quota attempt count is invalid");
  }
  if (quota.hardStopEnabled != null && quota.hardStopEnabled !== true) {
    errors.push("status.json quota hard stop cannot be disabled");
  }
  if (quota.reservedCallsThisRun != null && (
    !Number.isInteger(quota.reservedCallsThisRun) ||
    quota.reservedCallsThisRun < 0 ||
    quota.reservedCallsThisRun > DAILY_ATTEMPT_LIMIT
  )) {
    errors.push("status.json quota reserved-call count is invalid");
  }
}

function validateStatus(status, warnings, errors) {
  if (!status || typeof status !== "object") return errors.push("status.json is not an object");
  if (!isIsoDate(status.generatedAt)) errors.push("status.json generatedAt is invalid");
  const nextCheck = status.nextExpectedCheck ?? status.nextCheckAt;
  if (!isIsoDate(nextCheck)) errors.push("status.json next-check timestamp is invalid");
  if (typeof status.stale !== "boolean") errors.push("status.json stale flag is missing");
  if (!Number.isInteger(status.warningCount)) errors.push("status.json warningCount is invalid");
  if (status.warningCount !== warnings.warnings.length) errors.push("status warningCount does not match warnings.json");
  validateQuota(status.quota, errors);
}

export function validateBundle(bundle, { requireLiveForecast = false } = {}) {
  const errors = [];
  validateForecast(bundle.forecast, errors);
  validateWarnings(bundle.warnings, errors);
  validateNews(bundle.news, errors);
  validateCommunity(bundle.community, errors);
  validateStatus(bundle.status, bundle.warnings ?? { warnings: [] }, errors);
  if (requireLiveForecast) {
    if (bundle.forecast?.sample !== false) {
      errors.push("Production deployment requires a live Met Office or Open-Meteo forecast");
    }
    for (const name of ["warnings", "news", "community"]) {
      if (bundle[name]?.sample !== false) {
        errors.push(`Production deployment does not permit sample ${name} data`);
      }
    }
  }
  for (const [name, value] of Object.entries(bundle)) checkNoSecrets(value, errors, name);
  return errors;
}

async function readBundle(paths) {
  return {
    forecast: await readJson(paths.forecastPath),
    warnings: await readJson(paths.warningsPath),
    news: await readJson(paths.newsPath),
    community: await readJson(paths.communityPath),
    status: await readJson(paths.statusPath),
  };
}

function normaliseQuotaSnapshot(value, today) {
  if (!value || typeof value !== "object") return null;
  const day = value.utcDay ?? value.quotaDayUtc;
  const attempts = value.attempts ?? value.callsUsed;
  const limit = value.limit ?? value.limitPerUtcDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || day > today) return null;
  if (
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts > DAILY_ATTEMPT_LIMIT ||
    ![DAILY_ATTEMPT_LIMIT, LEGACY_DAILY_ATTEMPT_LIMIT].includes(limit)
  ) return null;
  return { ...value, day, attempts };
}

function mergeQuotaSnapshots(values, now) {
  const today = now.toISOString().slice(0, 10);
  const valid = values.map((value) => normaliseQuotaSnapshot(value, today)).filter(Boolean);
  if (!valid.length) return null;
  const latestDay = valid.map(({ day }) => day).sort().at(-1);
  const candidates = valid.filter(({ day }) => day === latestDay);
  const attempts = Math.max(...candidates.map((candidate) => candidate.attempts));
  const matchingMaximum = candidates.filter((candidate) => candidate.attempts === attempts);
  const freshest = matchingMaximum
    .slice()
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
  const unsafe = matchingMaximum.find((candidate) => candidate.safe === false);
  return {
    ...freshest,
    utcDay: latestDay,
    quotaDayUtc: latestDay,
    attempts,
    callsUsed: attempts,
    limit: DAILY_ATTEMPT_LIMIT,
    limitPerUtcDay: DAILY_ATTEMPT_LIMIT,
    remaining: DAILY_ATTEMPT_LIMIT - attempts,
    callsRemaining: DAILY_ATTEMPT_LIMIT - attempts,
    callsMadeThisRun: Math.max(0, ...candidates.map((candidate) => Number(candidate.callsMadeThisRun) || 0)),
    reservedCallsThisRun: Math.max(0, ...candidates.map((candidate) => Number(candidate.reservedCallsThisRun) || 0)),
    hardStopEnabled: true,
    safe: unsafe ? false : freshest.safe ?? true,
    reason: unsafe?.reason ?? freshest.reason ?? null,
  };
}

async function restoreLastValid(paths, now) {
  // Capture quota state before replacing status.json. A content validation failure
  // must never roll back attempts that were already reserved in this run.
  const [currentStatus, privateLedger] = await Promise.all([
    readJson(paths.statusPath, null).catch(() => null),
    readJson(paths.quotaLedgerPath, null).catch(() => null),
  ]);
  for (const fileName of DATA_FILE_NAMES) {
    await copyFileAtomic(path.join(paths.lastValidDir, fileName), path.join(paths.dataDir, fileName));
  }
  const restoredStatus = await readJson(paths.statusPath);
  const mergedQuota = mergeQuotaSnapshots(
    [restoredStatus?.quota, currentStatus?.quota, privateLedger],
    now,
  );
  if (mergedQuota) {
    restoredStatus.quota = mergedQuota;
    await writeJsonAtomic(paths.statusPath, restoredStatus);
  }
}

async function snapshotLastValid(paths, now) {
  const status = await readJson(paths.statusPath);
  status.deployedAt = now.toISOString();
  await writeJsonAtomic(paths.statusPath, status);
  await fs.mkdir(paths.lastValidDir, { recursive: true });
  for (const fileName of DATA_FILE_NAMES) {
    await copyFileAtomic(path.join(paths.dataDir, fileName), path.join(paths.lastValidDir, fileName));
  }
}

export async function validateGeneratedData({
  rootDir = process.cwd(),
  restoreOnFailure = false,
  snapshot = false,
  requireLiveForecast = false,
  now = new Date(),
} = {}) {
  const paths = createPaths(rootDir);
  let bundle;
  let errors;
  try {
    bundle = await readBundle(paths);
    errors = validateBundle(bundle, { requireLiveForecast });
  } catch (error) {
    errors = [`Generated data could not be read (${safeErrorCode(error)})`];
  }

  let restored = false;
  if (errors.length && restoreOnFailure) {
    try {
      await restoreLastValid(paths, now);
      bundle = await readBundle(paths);
      errors = validateBundle(bundle, { requireLiveForecast });
      restored = errors.length === 0;
    } catch {
      // Preserve the original validation errors below.
    }
  }

  if (errors.length) {
    const error = new Error(`Generated data validation failed:\n- ${errors.join("\n- ")}`);
    error.code = "generated-data-invalid";
    error.validationErrors = errors;
    throw error;
  }
  if (snapshot) await snapshotLastValid(paths, now);
  return { valid: true, restored, bundle };
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const result = await validateGeneratedData({
    restoreOnFailure: flags.has("--restore-on-failure"),
    snapshot: flags.has("--snapshot"),
    requireLiveForecast:
      flags.has("--require-live-forecast") ||
      process.env.WEATHERCHART_REQUIRE_LIVE_FORECAST === "true",
  });
  console.log(result.restored ? "Generated data restored from the last valid snapshot." : "Generated data is valid.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
