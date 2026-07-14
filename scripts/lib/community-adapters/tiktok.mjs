import { sanitisePublicUrl } from "../community.mjs";
import {
  accountExclusionReason,
  cleanPublicText,
  countExclusion,
  createAdapterResult,
  fetchJsonOnce,
  isRecentPublicItem,
  localModerationReason,
  locationFromCuratedItem,
  matchWeatherKeywords,
  platformCap,
  requestTimeout,
  safeAdapterErrorCode,
  shortPublicExcerpt,
} from "./common.mjs";

const TIKTOK_OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

function curatedVideoUrl(value, allowlist, blocklist) {
  const safe = sanitisePublicUrl(value, allowlist, blocklist);
  if (!safe || safe.platform !== "tiktok") return null;
  const parsed = new URL(safe.url);
  if (!/^\/@[^/]+\/video\/\d+\/?$/.test(parsed.pathname)) return null;
  parsed.search = "";
  return parsed.toString();
}

function accountFromUrl(value) {
  const match = new URL(value).pathname.match(/^\/@([^/]+)\/video\//);
  return match?.[1] ?? "";
}

export async function fetchTikTokCommunity({
  curated = {},
  fetchImpl = globalThis.fetch,
  keywords = {},
  allowlist = {},
  blocklist = {},
  now = new Date(),
} = {}) {
  const result = createAdapterResult("tiktok");
  if (curated?.enabled !== true) return result;

  const cap = platformCap(keywords, "tiktok", 6);
  const candidates = Array.isArray(curated?.approvedVideos) ? curated.approvedVideos.slice(0, cap) : [];
  result.state = "running";

  for (const item of candidates) {
    if (item?.familySafe !== true || !["approved", "manually-approved"].includes(String(item?.reviewStatus))) {
      countExclusion(result, "human-review-required");
      continue;
    }
    const directUrl = curatedVideoUrl(item?.url, allowlist, blocklist);
    if (!directUrl) {
      countExclusion(result, "url-not-allowed");
      continue;
    }
    const account = accountFromUrl(directUrl);
    const accountReason = accountExclusionReason("tiktok", account, allowlist, blocklist);
    if (accountReason) {
      countExclusion(result, accountReason);
      continue;
    }
    if (!isRecentPublicItem(item?.publishedAt, now, keywords.maximumAgeHours)) {
      countExclusion(result, "malformed-or-stale");
      continue;
    }

    const endpoint = new URL(TIKTOK_OEMBED_ENDPOINT);
    endpoint.searchParams.set("url", directUrl);
    result.audit.requests += 1;
    try {
      const metadata = await fetchJsonOnce({
        fetchImpl,
        url: endpoint,
        timeoutMs: requestTimeout(keywords),
      });
      result.audit.fetched += 1;
      const title = cleanPublicText(item.title ?? metadata?.title, 180);
      const author = cleanPublicText(metadata?.author_name ?? item.authorDisplayName ?? account, 100);
      const excerpt = shortPublicExcerpt(item.excerpt ?? metadata?.title, 220);
      if (!title || !author) {
        countExclusion(result, "invalid-payload");
        continue;
      }
      const moderationReason = localModerationReason(`${title} ${excerpt}`, blocklist);
      if (moderationReason) {
        countExclusion(result, moderationReason);
        continue;
      }
      const weatherKeywords = matchWeatherKeywords(`${title} ${excerpt}`, keywords, item.weatherKeywords ?? item.keywords);
      if (!weatherKeywords.length) {
        countExclusion(result, "no-weather-keyword");
        continue;
      }
      result.items.push({
        id: cleanPublicText(item.id, 100) || `tiktok-${new URL(directUrl).pathname.split("/").at(-1)}`,
        platform: "tiktok",
        sourceName: "TikTok",
        sourceHost: "www.tiktok.com",
        authorDisplayName: author,
        authorHandle: account ? `@${account}` : "",
        title,
        excerpt,
        url: directUrl,
        publishedAt: new Date(item.publishedAt).toISOString(),
        weatherKeywords,
        location: locationFromCuratedItem(item, `${title} ${excerpt}`, keywords),
        mediaType: "oembed-link",
        familySafe: true,
        reviewStatus: "approved",
        embedAllowed: true,
      });
      result.audit.accepted += 1;
    } catch (error) {
      const code = safeAdapterErrorCode(error);
      result.errorCode ??= code;
      countExclusion(result, code === "http-404" ? "provider-unavailable" : "provider-error");
    }
  }

  if (result.errorCode && result.items.length === 0 && result.audit.requests > 0) result.state = "error";
  else if (result.errorCode) result.state = "success-partial";
  else result.state = "success";
  return result;
}
