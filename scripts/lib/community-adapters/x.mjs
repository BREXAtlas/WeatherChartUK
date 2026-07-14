import {
  accountExclusionReason,
  cleanPublicText,
  coarsePlatformLocation,
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

const X_RECENT_SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";

export async function fetchXCommunity({
  bearerToken,
  fetchImpl = globalThis.fetch,
  keywords = {},
  allowlist = {},
  blocklist = {},
  now = new Date(),
} = {}) {
  const result = createAdapterResult("x");
  if (!bearerToken) return result;

  const cap = platformCap(keywords, "x", 10);
  const query = cleanPublicText(
    keywords?.providerQueries?.x ?? "(#UKWeather OR #WeatherAware) -is:retweet lang:en",
    500,
  );
  const url = new URL(X_RECENT_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.max(10, Math.min(100, cap * 2))));
  url.searchParams.set("tweet.fields", "created_at,author_id,lang,geo,possibly_sensitive");
  url.searchParams.set("expansions", "author_id,geo.place_id");
  url.searchParams.set("user.fields", "name,username");
  url.searchParams.set("place.fields", "full_name,country,country_code,place_type");

  result.state = "running";
  result.audit.requests = 1;
  try {
    const payload = await fetchJsonOnce({
      fetchImpl,
      url,
      timeoutMs: requestTimeout(keywords),
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!Array.isArray(payload?.data)) throw Object.assign(new Error("invalid"), { code: "invalid-payload" });
    const users = new Map((payload.includes?.users ?? []).map((entry) => [String(entry.id), entry]));
    const places = new Map((payload.includes?.places ?? []).map((entry) => [String(entry.id), entry]));
    result.audit.fetched = payload.data.length;

    for (const tweet of payload.data) {
      if (result.items.length >= cap) {
        countExclusion(result, "platform-cap");
        continue;
      }
      const id = cleanPublicText(tweet?.id, 80);
      const text = cleanPublicText(tweet?.text, 500);
      const user = users.get(String(tweet?.author_id)) ?? {};
      const username = cleanPublicText(user.username, 100).replace(/^@/, "");
      const authorName = cleanPublicText(user.name, 100) || username;
      if (!id || !text || !username || !isRecentPublicItem(tweet?.created_at, now, keywords.maximumAgeHours)) {
        countExclusion(result, "malformed-or-stale");
        continue;
      }
      if (tweet.possibly_sensitive !== false) {
        countExclusion(result, "family-safety-unknown");
        continue;
      }
      const accountReason = accountExclusionReason("x", [tweet.author_id, username], allowlist, blocklist);
      if (accountReason) {
        countExclusion(result, accountReason);
        continue;
      }
      const moderationReason = localModerationReason(text, blocklist);
      if (moderationReason) {
        countExclusion(result, moderationReason);
        continue;
      }
      const weatherKeywords = matchWeatherKeywords(text, keywords);
      if (!weatherKeywords.length) {
        countExclusion(result, "no-weather-keyword");
        continue;
      }
      const place = places.get(String(tweet?.geo?.place_id));
      const location = coarsePlatformLocation(place, keywords) ?? locationExplicitlyNamed(text, keywords);
      result.items.push({
        id: `x-${id}`,
        platform: "x",
        sourceName: "X",
        sourceHost: "x.com",
        authorDisplayName: authorName || "X account",
        authorHandle: `@${username}`,
        title: `Weather post by ${authorName || `@${username}`}`,
        excerpt: shortPublicExcerpt(text, 220),
        url: `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(id)}`,
        publishedAt: new Date(tweet.created_at).toISOString(),
        weatherKeywords,
        location,
        mediaType: "text-link",
        familySafe: true,
        reviewStatus: "automated-filtered",
        embedAllowed: false,
      });
      result.audit.accepted += 1;
    }
    result.state = "success";
  } catch (error) {
    result.state = "error";
    result.errorCode = safeAdapterErrorCode(error);
    countExclusion(result, "provider-error");
  }
  return result;
}
