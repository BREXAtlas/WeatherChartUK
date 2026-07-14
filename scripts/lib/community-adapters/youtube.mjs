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

const YOUTUBE_SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";

export async function fetchYouTubeCommunity({
  apiKey,
  fetchImpl = globalThis.fetch,
  keywords = {},
  allowlist = {},
  blocklist = {},
  now = new Date(),
} = {}) {
  const result = createAdapterResult("youtube");
  if (!apiKey) return result;

  const cap = platformCap(keywords, "youtube", 8);
  const query = cleanPublicText(keywords?.providerQueries?.youtube ?? "UK weather", 300);
  const url = new URL(YOUTUBE_SEARCH_ENDPOINT);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("regionCode", "GB");
  url.searchParams.set("relevanceLanguage", "en");
  url.searchParams.set("safeSearch", "strict");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("order", "date");
  url.searchParams.set("maxResults", String(Math.min(25, Math.max(cap, cap * 2))));
  url.searchParams.set("publishedAfter", new Date(now.getTime() - 48 * 3_600_000).toISOString());
  url.searchParams.set("q", query);
  url.searchParams.set(
    "fields",
    "items(id/videoId,snippet/title,snippet/description,snippet/publishedAt,snippet/channelId,snippet/channelTitle)",
  );

  result.state = "running";
  result.audit.requests = 1;
  try {
    const payload = await fetchJsonOnce({
      fetchImpl,
      url,
      timeoutMs: requestTimeout(keywords),
      headers: {
        "X-Goog-Api-Key": apiKey,
      },
    });
    if (!Array.isArray(payload?.items)) throw Object.assign(new Error("invalid"), { code: "invalid-payload" });
    result.audit.fetched = payload.items.length;

    for (const source of payload.items) {
      if (result.items.length >= cap) {
        countExclusion(result, "platform-cap");
        continue;
      }
      const videoId = cleanPublicText(source?.id?.videoId, 80);
      const snippet = source?.snippet;
      const title = cleanPublicText(snippet?.title, 180);
      const excerpt = shortPublicExcerpt(snippet?.description, 220);
      const publishedAt = snippet?.publishedAt;
      const channelId = cleanPublicText(snippet?.channelId, 100);
      const channelTitle = cleanPublicText(snippet?.channelTitle, 100);
      if (!videoId || !title || !channelId || !isRecentPublicItem(publishedAt, now, keywords.maximumAgeHours)) {
        countExclusion(result, "malformed-or-stale");
        continue;
      }
      const accountReason = accountExclusionReason("youtube", [channelId, channelTitle], allowlist, blocklist);
      if (accountReason) {
        countExclusion(result, accountReason);
        continue;
      }
      const moderationReason = localModerationReason(`${title} ${excerpt}`, blocklist);
      if (moderationReason) {
        countExclusion(result, moderationReason);
        continue;
      }
      const weatherKeywords = matchWeatherKeywords(`${title} ${excerpt}`, keywords);
      if (!weatherKeywords.length) {
        countExclusion(result, "no-weather-keyword");
        continue;
      }
      result.items.push({
        id: `youtube-${videoId}`,
        platform: "youtube",
        sourceName: "YouTube",
        sourceHost: "www.youtube.com",
        authorDisplayName: channelTitle || "YouTube creator",
        title,
        excerpt,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        publishedAt: new Date(publishedAt).toISOString(),
        weatherKeywords,
        location: locationExplicitlyNamed(`${title} ${excerpt}`, keywords),
        mediaType: "video-link",
        familySafe: true,
        reviewStatus: "automated-filtered",
        embedAllowed: true,
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
