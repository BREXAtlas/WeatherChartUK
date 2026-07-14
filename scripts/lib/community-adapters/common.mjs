import { communityContentExclusionReason } from "../community.mjs";

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export class CommunityAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "CommunityAdapterError";
    this.code = code;
  }
}

export function cleanPublicText(value, maximum = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function shortPublicExcerpt(value, maximum = 220) {
  const limit = Math.max(40, Math.min(Number(maximum) || 220, 500));
  const text = cleanPublicText(value, 2_000);
  if (text.length <= limit) return text;
  const boundary = text.slice(0, limit - 1).replace(/\s+\S*$/, "").trimEnd();
  return `${boundary || text.slice(0, limit - 1).trimEnd()}…`;
}

export function createAdapterResult(platform, state = "disabled") {
  return {
    platform,
    state,
    errorCode: null,
    items: [],
    audit: { requests: 0, fetched: 0, accepted: 0, excluded: {} },
  };
}

export function countExclusion(result, reason, amount = 1) {
  const safeReason = /^[a-z0-9-]{1,48}$/.test(String(reason)) ? String(reason) : "rejected";
  result.audit.excluded[safeReason] = (result.audit.excluded[safeReason] ?? 0) + amount;
}

export function safeAdapterErrorCode(error) {
  if (typeof error?.code === "string" && /^[a-z0-9-]{1,48}$/i.test(error.code)) return error.code.toLowerCase();
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "request-timeout";
  return "request-failed";
}

export async function fetchJsonOnce({
  fetchImpl = globalThis.fetch,
  url,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw new CommunityAdapterError("fetch-unavailable");
  const boundedTimeout = Math.max(250, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 15_000));
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new CommunityAdapterError("request-timeout"));
    }, boundedTimeout);
  });

  try {
    const request = async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response || typeof response.json !== "function") throw new CommunityAdapterError("invalid-response");
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : 0;
        throw new CommunityAdapterError(status >= 400 && status <= 599 ? `http-${status}` : "http-error");
      }
      const contentLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new CommunityAdapterError("response-too-large");
      }
      try {
        return await response.json();
      } catch {
        throw new CommunityAdapterError("invalid-json");
      }
    };
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normaliseAccount(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function accountValues(config, property, platform) {
  const raw = config?.[property]?.[platform] ?? [];
  return new Set((Array.isArray(raw) ? raw : []).map((value) => {
    if (value && typeof value === "object") return normaliseAccount(value.id ?? value.handle ?? value.name);
    return normaliseAccount(value);
  }).filter(Boolean));
}

export function accountExclusionReason(platform, accountValuesToCheck, allowlist = {}, blocklist = {}) {
  const candidates = (Array.isArray(accountValuesToCheck) ? accountValuesToCheck : [accountValuesToCheck])
    .map(normaliseAccount)
    .filter(Boolean);
  const blocked = accountValues(blocklist, "blockedAccounts", platform);
  if (candidates.some((candidate) => blocked.has(candidate))) return "blocked-account";
  if (allowlist?.requireManualAccountAllowlist?.[platform] === true) {
    const allowed = accountValues(allowlist, "manualAllowedAccounts", platform);
    if (!candidates.some((candidate) => allowed.has(candidate))) return "account-not-allowlisted";
  }
  return null;
}

function keywordValues(config) {
  const raw = Array.isArray(config?.allowedWeatherKeywords) ? config.allowedWeatherKeywords : [];
  return raw.map((entry) => cleanPublicText(entry?.keyword ?? entry, 60).toLowerCase()).filter(Boolean);
}

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}

export function matchWeatherKeywords(text, config = {}, supplied = []) {
  const source = cleanPublicText(text, 2_000).toLowerCase();
  const allowed = keywordValues(config);
  const matches = allowed.filter((keyword) => containsPhrase(source, keyword));
  for (const value of Array.isArray(supplied) ? supplied : []) {
    const keyword = cleanPublicText(value, 60).toLowerCase();
    if (allowed.includes(keyword) && !matches.includes(keyword)) matches.push(keyword);
  }
  return matches.slice(0, 12);
}

export function localModerationReason(text, blocklist = {}) {
  return communityContentExclusionReason(cleanPublicText(text, 3_000), blocklist);
}

export function isRecentPublicItem(publishedAt, now, maximumAgeHours = 48) {
  const published = Date.parse(publishedAt ?? "");
  if (!Number.isFinite(published) || published > now.getTime() + 5 * 60_000) return false;
  const boundedHours = Math.max(1, Math.min(Number(maximumAgeHours) || 48, 48));
  return now.getTime() - published <= boundedHours * 3_600_000;
}

function unknownLocation() {
  return {
    label: "Location not verified",
    region: null,
    basis: "unknown",
    basisLabel: "Location not verified",
    confidence: "low",
    latitude: null,
    longitude: null,
  };
}

function configuredLocations(config) {
  return (Array.isArray(config?.locations) ? config.locations : []).filter((entry) => entry && entry.name);
}

export function locationExplicitlyNamed(text, config = {}) {
  const source = cleanPublicText(text, 3_000).toLowerCase();
  for (const entry of configuredLocations(config)) {
    const aliases = [entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
      .map((value) => cleanPublicText(value, 100).toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (aliases.some((alias) => containsPhrase(source, alias))) {
      return {
        label: cleanPublicText(entry.name, 100),
        region: cleanPublicText(entry.region, 100) || null,
        basis: "author_explicit",
        basisLabel: "Location named by author",
        confidence: "medium",
        latitude: null,
        longitude: null,
      };
    }
  }
  return unknownLocation();
}

export function coarsePlatformLocation(place, config = {}) {
  if (!place || typeof place !== "object") return null;
  if (place.country_code && String(place.country_code).toUpperCase() !== "GB") return null;
  const placeType = String(place.place_type ?? "").toLowerCase();
  if (!new Set(["city", "admin", "country"]).has(placeType)) return null;
  const fullName = cleanPublicText(place.full_name ?? place.name, 140);
  if (!fullName) return null;
  const named = locationExplicitlyNamed(fullName, config);
  const label = named.basis === "author_explicit" ? named.label : cleanPublicText(fullName.split(",")[0], 100);
  if (!label) return null;
  return {
    label,
    region: named.region,
    basis: "platform_geotag",
    basisLabel: "Platform geotag",
    confidence: placeType === "city" ? "high" : "medium",
    latitude: null,
    longitude: null,
  };
}

export function locationFromCuratedItem(item, text, config = {}) {
  const basis = String(item?.location?.basis ?? "");
  const locationText = cleanPublicText(item?.location?.name ?? item?.location?.label, 100);
  if (locationText && ["author_explicit", "platform_geotag"].includes(basis)) {
    const named = locationExplicitlyNamed(locationText, config);
    if (named.basis === "author_explicit") {
      return {
        ...named,
        basis,
        basisLabel: basis === "platform_geotag" ? "Platform geotag" : "Location named by author",
        confidence: basis === "platform_geotag" ? "high" : "medium",
      };
    }
  }
  return locationExplicitlyNamed(text, config);
}

export function platformCap(config, platform, fallback) {
  const value = Number(config?.perPlatformCaps?.[platform]);
  return Math.max(1, Math.min(Number.isInteger(value) ? value : fallback, 25));
}

export function requestTimeout(config) {
  return Math.max(250, Math.min(Number(config?.requestTimeoutMs) || DEFAULT_TIMEOUT_MS, 15_000));
}
