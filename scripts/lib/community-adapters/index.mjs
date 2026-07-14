import { fetchMastodonCommunity } from "./mastodon.mjs";
import { fetchTikTokCommunity } from "./tiktok.mjs";
import { fetchXCommunity } from "./x.mjs";
import { fetchYouTubeCommunity } from "./youtube.mjs";

function mergeExclusions(results) {
  const aggregate = {};
  for (const result of results) {
    for (const [reason, count] of Object.entries(result.audit.excluded)) {
      aggregate[reason] = (aggregate[reason] ?? 0) + count;
    }
  }
  return aggregate;
}

function publicPlatformAudit(result) {
  return {
    state: result.state,
    requests: result.audit.requests,
    fetched: result.audit.fetched,
    accepted: result.audit.accepted,
    excluded: { ...result.audit.excluded },
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

export async function runCommunityAdapters({
  env = process.env,
  fetchImpl = globalThis.fetch,
  keywords = {},
  curatedTikTok = {},
  allowlist = {},
  blocklist = {},
  now = new Date(),
} = {}) {
  const options = { fetchImpl, keywords, allowlist, blocklist, now };
  const results = await Promise.all([
    fetchYouTubeCommunity({ ...options, apiKey: env.YOUTUBE_API_KEY }),
    fetchXCommunity({ ...options, bearerToken: env.X_BEARER_TOKEN }),
    fetchTikTokCommunity({ ...options, curated: curatedTikTok }),
    fetchMastodonCommunity(options),
  ]);
  const totalCap = Math.max(1, Math.min(Number(keywords?.perPlatformCaps?.total) || 24, 40));
  const items = results
    .flatMap((result) => result.items)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, totalCap);
  const acceptedBeforeTotalCap = results.reduce((sum, result) => sum + result.audit.accepted, 0);
  const excluded = mergeExclusions(results);
  if (acceptedBeforeTotalCap > totalCap) excluded["total-cap"] = acceptedBeforeTotalCap - totalCap;
  return {
    items,
    audit: {
      version: 1,
      containsPostText: false,
      requests: results.reduce((sum, result) => sum + result.audit.requests, 0),
      fetched: results.reduce((sum, result) => sum + result.audit.fetched, 0),
      accepted: items.length,
      excluded,
      platforms: Object.fromEntries(results.map((result) => [result.platform, publicPlatformAudit(result)])),
    },
    results,
  };
}
