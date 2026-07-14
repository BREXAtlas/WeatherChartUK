import { stableId } from "./rss.mjs";

export const DEFAULT_ALLOWED_COMMUNITY_DOMAINS = new Map([
  ["www.youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["www.youtube-nocookie.com", "youtube"],
  ["www.tiktok.com", "tiktok"],
  ["bsky.app", "bluesky"],
  ["mastodon.social", "mastodon"],
  ["x.com", "x"],
]);

export function allowedCommunityDomains(config) {
  const configured = Array.isArray(config?.allowedDomains) ? config.allowedDomains : [];
  if (!configured.length) return DEFAULT_ALLOWED_COMMUNITY_DOMAINS;
  return new Map(configured.map((entry) => [String(entry.domain).toLowerCase(), entry.platform]));
}

export function sanitisePublicUrl(value, allowlist = {}, blocklist = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || (url.port && url.port !== "443")) return null;
    const domains = allowedCommunityDomains(allowlist);
    const platform = domains.get(url.hostname.toLowerCase());
    if (!platform) return null;
    if ((blocklist.blockedDomains ?? []).map(String).includes(url.hostname.toLowerCase())) return null;
    for (const name of allowlist.blockedQueryParameters ?? []) url.searchParams.delete(name);
    url.hash = "";
    return { url: url.toString(), platform };
  } catch {
    return null;
  }
}

export function communityContentExclusionReason(value, blocklist = {}) {
  const text = String(value).toLowerCase();
  for (const group of Object.values(blocklist?.blockedTermGroups ?? {})) {
    for (const term of group) {
      if (text.includes(String(term).toLowerCase())) return "blocked-content";
    }
  }
  for (const rule of blocklist?.sensitivePatterns ?? []) {
    try {
      if (new RegExp(rule.pattern, "i").test(text) && ["reject", "review"].includes(rule.action)) {
        return rule.action === "review" ? "manual-review-required" : "sensitive-content";
      }
    } catch {
      return "invalid-moderation-rule";
    }
  }
  return null;
}

export function isAllowedCommunityUrl(value, allowlist = {}) {
  return sanitisePublicUrl(value, allowlist) !== null;
}

function expiry(value, publishedAt, now, maximumHours = 48) {
  const maximum = new Date(Date.parse(publishedAt) + maximumHours * 3_600_000);
  const requested = new Date(value ?? maximum);
  if (!Number.isFinite(requested.getTime()) || requested > maximum) return maximum.toISOString();
  return requested.toISOString();
}

export function sanitiseCommunityItem(item, { allowlist = {}, blocklist = {}, now = new Date() } = {}) {
  const safeUrl = sanitisePublicUrl(item?.url, allowlist, blocklist);
  if (!safeUrl) return null;
  const title = String(item?.title ?? "").trim().slice(0, 180);
  const excerpt = String(item?.excerpt ?? "").trim().slice(0, Number(allowlist.maximumExcerptCharacters) || 220);
  const coarseLocationText = item?.location && typeof item.location === "object"
    ? `${item.location.label ?? item.location.name ?? ""} ${item.location.region ?? ""}`
    : "";
  if (!title || communityContentExclusionReason(`${title} ${excerpt} ${coarseLocationText}`, blocklist)) return null;
  if (item.familySafe !== true && item.safeForFamilyDisplay !== true) return null;
  const published = new Date(item.publishedAt);
  if (!Number.isFinite(published.getTime())) return null;
  const expiresAt = expiry(item.expiresAt, published.toISOString(), now, 48);
  if (Date.parse(expiresAt) <= now.getTime()) return null;
  const location = item.location && typeof item.location === "object"
    ? {
        label: String(item.location.label ?? item.location.name ?? "Location not verified").slice(0, 100),
        region: item.location.region ? String(item.location.region).slice(0, 100) : null,
        basis: String(item.location.basis ?? "unknown").slice(0, 80),
        basisLabel: String(item.location.basisLabel ?? "Location not verified").slice(0, 80),
        confidence: ["high", "medium", "low"].includes(item.location.confidence)
          ? item.location.confidence
          : "low",
        latitude: null,
        longitude: null,
      }
    : {
        label: "Location not verified",
        region: null,
        basis: "unknown",
        basisLabel: "Location not verified",
        confidence: "low",
        latitude: null,
        longitude: null,
      };
  const authorDisplayName = String(item.authorDisplayName ?? item.author ?? "Public contributor").slice(0, 100);
  const sourceHost = new URL(safeUrl.url).hostname.toLowerCase();
  const sourceName = String(item.sourceName ?? safeUrl.platform).trim().slice(0, 60);
  const authorHandle = String(item.authorHandle ?? "").trim().slice(0, 180);
  return {
    id: String(item.id ?? stableId(safeUrl.url)).slice(0, 100),
    platform: safeUrl.platform,
    author: authorDisplayName,
    authorDisplayName,
    authorHandle,
    sourceName,
    sourceHost,
    title,
    excerpt,
    url: safeUrl.url,
    publishedAt: published.toISOString(),
    expiresAt,
    keywords: Array.isArray(item.keywords ?? item.weatherKeywords)
      ? (item.keywords ?? item.weatherKeywords).map(String).slice(0, 12)
      : [],
    location,
    mediaType: String(item.mediaType ?? "text-link"),
    familySafe: true,
    reviewStatus: String(item.reviewStatus ?? "approved"),
    verified: false,
    embedAllowed: Boolean(item.embedAllowed),
  };
}

export function normaliseCommunityItems(items, options = {}) {
  const byUrl = new Map();
  for (const item of items) {
    const safe = sanitiseCommunityItem(item, options);
    if (safe && !byUrl.has(safe.url)) byUrl.set(safe.url, safe);
  }
  return [...byUrl.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
