import { sanitisePublicUrl } from "../community.mjs";
import {
  accountExclusionReason,
  cleanPublicText,
  countExclusion,
  createAdapterResult,
  fetchJsonOnce,
  isRecentPublicItem,
  localModerationReason,
  locationExplicitlyNamed,
  matchWeatherKeywords,
  platformCap,
  requestTimeout,
  safeAdapterErrorCode,
  shortPublicExcerpt,
} from "./common.mjs";

const DEFAULT_SOURCE = Object.freeze({
  instance: "https://mastodon.social",
  hashtag: "UKWeather",
});
const MAX_SOURCES = 3;
const USER_AGENT = "WeatherChartUK/1.0 (+https://github.com/BREXAtlas/Cool-Isle)";

function configuredSources(keywords, allowlist, blocklist) {
  const configured = Array.isArray(keywords?.providerSources?.mastodon)
    ? keywords.providerSources.mastodon
    : [DEFAULT_SOURCE];
  const sources = [];
  for (const entry of configured.slice(0, MAX_SOURCES)) {
    try {
      const origin = new URL(entry?.instance);
      const hashtag = cleanPublicText(entry?.hashtag, 50).replace(/^#/, "");
      if (
        origin.protocol !== "https:"
        || origin.username
        || origin.password
        || (origin.port && origin.port !== "443")
        || origin.pathname !== "/"
        || origin.search
        || origin.hash
        || !/^[a-z0-9_]{2,50}$/i.test(hashtag)
      ) continue;
      const hostCheck = sanitisePublicUrl(`${origin.origin}/`, allowlist, blocklist);
      if (!hostCheck || hostCheck.platform !== "mastodon") continue;
      sources.push({ origin: origin.origin, hostname: origin.hostname.toLowerCase(), hashtag });
    } catch {
      // Invalid configured sources are skipped; they never become request targets.
    }
  }
  return sources;
}

function publicHandle(account, hostname) {
  const acct = cleanPublicText(account?.acct ?? account?.username, 160).replace(/^@/, "");
  if (!acct) return "";
  return `@${acct.includes("@") ? acct : `${acct}@${hostname}`}`;
}

function isEligiblePublicStatus(status) {
  return status?.visibility === "public"
    && status?.sensitive === false
    && !cleanPublicText(status?.spoiler_text, 200)
    && !status?.reblog
    && !status?.in_reply_to_id
    && status?.account?.bot !== true
    && status?.account?.locked !== true
    && (!status?.language || String(status.language).toLowerCase().startsWith("en"));
}

export async function fetchMastodonCommunity({
  fetchImpl = globalThis.fetch,
  keywords = {},
  allowlist = {},
  blocklist = {},
  now = new Date(),
} = {}) {
  const result = createAdapterResult("mastodon");
  const sources = configuredSources(keywords, allowlist, blocklist);
  if (!sources.length) return result;

  const cap = platformCap(keywords, "mastodon", 8);
  result.state = "running";
  let successfulRequests = 0;

  for (const source of sources) {
    const endpoint = new URL(`/api/v1/timelines/tag/${encodeURIComponent(source.hashtag)}`, source.origin);
    endpoint.searchParams.set("limit", String(Math.min(40, Math.max(10, cap * 4))));
    result.audit.requests += 1;
    try {
      const payload = await fetchJsonOnce({
        fetchImpl,
        url: endpoint,
        timeoutMs: requestTimeout(keywords),
        headers: { "User-Agent": USER_AGENT },
      });
      if (!Array.isArray(payload)) throw Object.assign(new Error("invalid"), { code: "invalid-payload" });
      successfulRequests += 1;
      result.audit.fetched += payload.length;

      for (const status of payload) {
        if (result.items.length >= cap) {
          countExclusion(result, "platform-cap");
          continue;
        }
        if (!isEligiblePublicStatus(status)) {
          countExclusion(result, "not-eligible-public-post");
          continue;
        }
        const directUrl = sanitisePublicUrl(status?.url, allowlist, blocklist);
        if (!directUrl || directUrl.platform !== "mastodon" || new URL(directUrl.url).hostname !== source.hostname) {
          countExclusion(result, "source-host-not-reviewed");
          continue;
        }
        const text = cleanPublicText(status?.content, 500);
        const statusId = cleanPublicText(status?.id, 80);
        const publishedAt = status?.created_at;
        const account = status?.account ?? {};
        const handle = publicHandle(account, source.hostname);
        const author = cleanPublicText(account?.display_name, 100)
          || cleanPublicText(account?.username, 100);
        if (!statusId || !text || !handle || !author || !isRecentPublicItem(publishedAt, now, keywords.maximumAgeHours)) {
          countExclusion(result, "malformed-or-stale");
          continue;
        }
        const accountReason = accountExclusionReason(
          "mastodon",
          [account?.id, account?.acct, account?.username, handle],
          allowlist,
          blocklist,
        );
        if (accountReason) {
          countExclusion(result, accountReason);
          continue;
        }
        const moderationReason = localModerationReason(text, blocklist);
        if (moderationReason) {
          countExclusion(result, moderationReason);
          continue;
        }
        const weatherKeywords = matchWeatherKeywords(text, keywords, [source.hashtag]);
        if (!weatherKeywords.length) {
          countExclusion(result, "no-weather-keyword");
          continue;
        }
        const location = locationExplicitlyNamed(text, keywords);
        if (allowlist?.requireCoarseLocation === true && location.basis === "unknown") {
          countExclusion(result, "no-coarse-location");
          continue;
        }
        result.items.push({
          id: `mastodon-${statusId}`,
          platform: "mastodon",
          sourceName: "Mastodon",
          sourceHost: source.hostname,
          authorDisplayName: author,
          authorHandle: handle,
          title: `Weather post by ${author}`,
          excerpt: shortPublicExcerpt(text, 220),
          url: directUrl.url,
          publishedAt: new Date(publishedAt).toISOString(),
          weatherKeywords,
          location,
          mediaType: "text-link",
          familySafe: true,
          reviewStatus: "automated-filtered",
          embedAllowed: false,
        });
        result.audit.accepted += 1;
      }
    } catch (error) {
      result.errorCode ??= safeAdapterErrorCode(error);
      countExclusion(result, "provider-error");
    }
  }

  if (successfulRequests === 0) result.state = "error";
  else if (successfulRequests < sources.length) result.state = "success-partial";
  else result.state = "success";
  return result;
}
