import assert from "node:assert/strict";
import test from "node:test";
import { fetchMastodonCommunity } from "../scripts/lib/community-adapters/mastodon.mjs";
import { fetchTikTokCommunity } from "../scripts/lib/community-adapters/tiktok.mjs";
import { fetchXCommunity } from "../scripts/lib/community-adapters/x.mjs";
import { fetchYouTubeCommunity } from "../scripts/lib/community-adapters/youtube.mjs";
import { runCommunityAdapters } from "../scripts/lib/community-adapters/index.mjs";
import { runCommunityUpdate } from "../scripts/update-community-pulse.mjs";
import { validateBundle } from "../scripts/validate-generated-data.mjs";
import { communityContentExclusionReason, normaliseCommunityItems } from "../scripts/lib/community.mjs";
import { readJson, writeJsonAtomic } from "../scripts/lib/fs-json.mjs";
import { removeRoot, temporaryRoot } from "./helpers.mjs";

const now = new Date("2026-07-13T18:00:00.000Z");
const committedBlocklist = await readJson(new URL("../weatherchart/config/social-blocklist.json", import.meta.url));
const keywords = {
  providerQueries: {
    youtube: "UK weather rain",
    x: "#UKWeather -is:retweet lang:en",
  },
  providerSources: { mastodon: [] },
  allowedWeatherKeywords: ["weather", "rain", "snow", "wind"],
  locations: [
    { name: "Manchester", region: "North West England", aliases: ["Greater Manchester"] },
    { name: "Glasgow", region: "Scotland", aliases: ["Glasgow area"] },
    { name: "Cardiff", region: "South Wales", aliases: ["Caerdydd"] },
  ],
  perPlatformCaps: { youtube: 2, x: 2, tiktok: 2, mastodon: 2, total: 8 },
  maximumAgeHours: 48,
  requestTimeoutMs: 250,
};

const allowlist = {
  allowedDomains: [
    { domain: "www.youtube.com", platform: "youtube" },
    { domain: "www.tiktok.com", platform: "tiktok" },
    { domain: "x.com", platform: "x" },
    { domain: "mastodon.social", platform: "mastodon" },
  ],
  blockedQueryParameters: ["utm_source"],
  maximumExcerptCharacters: 220,
  requireManualAccountAllowlist: { youtube: true, x: false, tiktok: false },
  manualAllowedAccounts: { youtube: ["allowed-channel"], x: [], tiktok: [] },
};

const blocklist = {
  blockedDomains: [],
  blockedAccounts: { youtube: ["blocked-channel"], x: ["blocked_x"], tiktok: ["blocked_tiktok"], mastodon: [] },
  blockedTermGroups: { unsafe: ["unsafe phrase"] },
  sensitivePatterns: [],
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return payload; },
  };
}

async function seedLiveYouTubeDataset(paths) {
  await Promise.all([
    writeJsonAtomic(paths.socialKeywordsPath, keywords),
    writeJsonAtomic(paths.socialAllowlistPath, allowlist),
    writeJsonAtomic(paths.socialBlocklistPath, blocklist),
    writeJsonAtomic(paths.curatedTikTokPath, { enabled: false, approvedVideos: [] }),
    writeJsonAtomic(paths.communityPath, {
      schemaVersion: 1,
      sample: false,
      generatedAt: now.toISOString(),
      items: [{
        id: "youtube-previous",
        platform: "youtube",
        author: "Previous creator",
        title: "Earlier rain in Manchester",
        excerpt: "A previously published public weather item.",
        url: "https://www.youtube.com/watch?v=previous",
        publishedAt: "2026-07-13T17:00:00.000Z",
        expiresAt: "2026-07-15T17:00:00.000Z",
        keywords: ["rain"],
        location: {
          label: "Manchester",
          region: "North West England",
          basis: "author_explicit",
          basisLabel: "Location named by author",
          confidence: "medium",
          latitude: null,
          longitude: null,
        },
        mediaType: "video-link",
        familySafe: true,
        reviewStatus: "automated-filtered",
        embedAllowed: true,
      }],
    }),
  ]);
}

test("YouTube uses the official API once, keeps its key out of the URL, and enforces account controls", async () => {
  const calls = [];
  const result = await fetchYouTubeCommunity({
    apiKey: "youtube-test-secret",
    keywords,
    allowlist,
    blocklist,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        items: [
          {
            id: { videoId: "accepted-video" },
            snippet: {
              title: "Rain moving across Greater Manchester",
              description: "Public UK weather update.",
              publishedAt: "2026-07-13T17:00:00Z",
              channelId: "allowed-channel",
              channelTitle: "Allowed Channel",
            },
          },
          {
            id: { videoId: "blocked-video" },
            snippet: {
              title: "Rain in Manchester",
              description: "Weather update.",
              publishedAt: "2026-07-13T17:00:00Z",
              channelId: "blocked-channel",
              channelTitle: "Blocked Channel",
            },
          },
          {
            id: { videoId: "not-allowed-video" },
            snippet: {
              title: "Wind in Manchester",
              description: "Weather update.",
              publishedAt: "2026-07-13T17:00:00Z",
              channelId: "other-channel",
              channelTitle: "Other Channel",
            },
          },
        ],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "www.googleapis.com");
  assert.equal(new URL(calls[0].url).searchParams.has("key"), false);
  assert.match(new URL(calls[0].url).searchParams.get("fields"), /snippet\/title/);
  assert.equal(calls[0].options.headers["X-Goog-Api-Key"], "youtube-test-secret");
  assert.equal(new URL(calls[0].url).searchParams.get("safeSearch"), "strict");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].location.label, "Manchester");
  assert.equal(result.items[0].location.basisLabel, "Location named by author");
  assert.equal(result.audit.excluded["blocked-account"], 1);
  assert.equal(result.audit.excluded["account-not-allowlisted"], 1);
  assert.equal(JSON.stringify(result).includes("youtube-test-secret"), false);
});

test("X recent search uses coarse public place metadata and emits no provider geometry", async () => {
  const calls = [];
  const result = await fetchXCommunity({
    bearerToken: "x-test-secret",
    keywords,
    allowlist: { ...allowlist, requireManualAccountAllowlist: { youtube: false, x: false, tiktok: false } },
    blocklist,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        data: [
          {
            id: "123456",
            text: "Heavy rain in Glasgow this afternoon #UKWeather",
            created_at: "2026-07-13T17:15:00Z",
            author_id: "user-1",
            possibly_sensitive: false,
            geo: { place_id: "place-1", coordinates: { coordinates: [-4.25, 55.86] } },
          },
          {
            id: "123457",
            text: "Snow in Glasgow",
            created_at: "2026-07-13T17:10:00Z",
            author_id: "user-2",
            possibly_sensitive: true,
          },
        ],
        includes: {
          users: [
            { id: "user-1", name: "Glasgow Sky", username: "glasgowsky" },
            { id: "user-2", name: "Unknown", username: "unknown" },
          ],
          places: [{
            id: "place-1",
            full_name: "Glasgow, Scotland",
            country_code: "GB",
            place_type: "city",
            geo: { bbox: [-4.4, 55.7, -4.0, 56.0] },
          }],
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, "https://api.x.com");
  assert.equal(calls[0].options.headers.Authorization, "Bearer x-test-secret");
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].location, {
    label: "Glasgow",
    region: "Scotland",
    basis: "platform_geotag",
    basisLabel: "Platform geotag",
    confidence: "high",
    latitude: null,
    longitude: null,
  });
  assert.equal(result.audit.excluded["family-safety-unknown"], 1);
  assert.equal(JSON.stringify(result).includes("55.86"), false);
  assert.equal(JSON.stringify(result).includes("x-test-secret"), false);
});

test("TikTok checks only manually approved URLs through public oEmbed and discards embed HTML", async () => {
  const calls = [];
  const result = await fetchTikTokCommunity({
    curated: {
      enabled: true,
      approvedVideos: [
        {
          id: "cardiff-rain",
          url: "https://www.tiktok.com/@skywatch/video/1234567890123456789?utm_source=test",
          title: "Rain over Cardiff",
          excerpt: "A public weather clip mentioning rain in Cardiff.",
          publishedAt: "2026-07-13T16:00:00Z",
          weatherKeywords: ["rain"],
          location: { name: "Cardiff", basis: "author_explicit" },
          familySafe: true,
          reviewStatus: "approved",
        },
        {
          url: "https://www.tiktok.com/@unreviewed/video/1234567890123456790",
          publishedAt: "2026-07-13T16:00:00Z",
          familySafe: false,
          reviewStatus: "pending",
        },
      ],
    },
    keywords,
    allowlist,
    blocklist,
    now,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        title: "Rain over Cardiff",
        author_name: "Sky Watch",
        html: "<script>must never be persisted</script>",
        thumbnail_url: "https://unsafe-cdn.invalid/private.jpg",
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, "/oembed");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://www.tiktok.com/@skywatch/video/1234567890123456789");
  assert.equal(result.items[0].location.basisLabel, "Location named by author");
  assert.equal(result.audit.excluded["human-review-required"], 1);
  assert.equal(JSON.stringify(result).includes("must never be persisted"), false);
  assert.equal(JSON.stringify(result).includes("unsafe-cdn.invalid"), false);
});

test("Mastodon uses a documented public hashtag timeline and retains direct attributed local posts only", async () => {
  const calls = [];
  const result = await fetchMastodonCommunity({
    keywords: {
      ...keywords,
      providerSources: { mastodon: [{ instance: "https://mastodon.social", hashtag: "UKWeather" }] },
    },
    allowlist: { ...allowlist, requireCoarseLocation: true },
    blocklist,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse([
        {
          id: "1001",
          url: "https://mastodon.social/@skywatch/1001?utm_source=feed",
          created_at: "2026-07-13T17:30:00Z",
          content: "<p>Fresh <strong>rain</strong> crossing Manchester this evening. #UKWeather</p>",
          visibility: "public",
          sensitive: false,
          spoiler_text: "",
          language: "en",
          in_reply_to_id: null,
          reblog: null,
          account: {
            id: "account-1",
            username: "skywatch",
            acct: "skywatch",
            display_name: "Sky Watch",
            bot: false,
            locked: false,
          },
        },
        {
          id: "1002",
          url: "https://remote.example/@weather/1002",
          created_at: "2026-07-13T17:25:00Z",
          content: "<p>Rain in Manchester. #UKWeather</p>",
          visibility: "public",
          sensitive: false,
          spoiler_text: "",
          language: "en",
          in_reply_to_id: null,
          reblog: null,
          account: { id: "account-2", username: "weather", acct: "weather@remote.example", display_name: "Remote Weather", bot: false, locked: false },
        },
        {
          id: "1003",
          url: "https://mastodon.social/@weatherbot/1003",
          created_at: "2026-07-13T17:20:00Z",
          content: "<p>Rain in Manchester. #UKWeather</p>",
          visibility: "public",
          sensitive: false,
          spoiler_text: "",
          language: "en",
          in_reply_to_id: null,
          reblog: null,
          account: { id: "account-3", username: "weatherbot", acct: "weatherbot", display_name: "Weather Bot", bot: true, locked: false },
        },
      ]);
    },
  });

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.origin, "https://mastodon.social");
  assert.equal(requestUrl.pathname, "/api/v1/timelines/tag/UKWeather");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.match(calls[0].options.headers["User-Agent"], /WeatherChartUK/);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://mastodon.social/@skywatch/1001");
  assert.equal(result.items[0].authorDisplayName, "Sky Watch");
  assert.equal(result.items[0].authorHandle, "@skywatch@mastodon.social");
  assert.equal(result.items[0].sourceHost, "mastodon.social");
  assert.equal(result.items[0].location.label, "Manchester");
  assert.equal(result.audit.excluded["source-host-not-reviewed"], 1);
  assert.equal(result.audit.excluded["not-eligible-public-post"], 1);
});

test("missing credentials and disabled curation make no network calls and retain a count-only audit", async () => {
  let calls = 0;
  const result = await runCommunityAdapters({
    env: {},
    keywords,
    curatedTikTok: { enabled: false, approvedVideos: [] },
    allowlist,
    blocklist,
    now,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be used");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.audit.excluded, {});
  assert.equal(result.audit.containsPostText, false);
  assert.equal(JSON.stringify(result.audit).includes("#UKWeather"), false);
});

test("inline email and phone-like personal data are rejected when no review queue exists", () => {
  assert.equal(
    communityContentExclusionReason("Rain report — contact jane@example.org for details", committedBlocklist),
    "sensitive-content",
  );
  assert.equal(
    communityContentExclusionReason("Wind update, call +44 7700 900123", committedBlocklist),
    "manual-review-required",
  );
  const preciseLocation = normaliseCommunityItems([{
    url: "https://x.com/example/status/1",
    title: "Rain nearby",
    excerpt: "A short weather note.",
    publishedAt: "2026-07-13T17:00:00Z",
    familySafe: true,
    location: { label: "10 High Street", basis: "author_explicit", confidence: "high" },
  }], { blocklist: committedBlocklist, now });
  assert.deepEqual(preciseLocation, []);
});

test("provider timeout is bounded and never retried", async () => {
  let calls = 0;
  const result = await fetchYouTubeCommunity({
    apiKey: "timeout-secret",
    keywords,
    allowlist,
    blocklist,
    now,
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "request-timeout");
});

test("community updater publishes an empty non-sample dataset when every source is disabled", async (t) => {
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await writeJsonAtomic(paths.socialKeywordsPath, { providerSources: { mastodon: [] } });
  let calls = 0;
  const result = await runCommunityUpdate({
    rootDir,
    now: () => now,
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be used");
    },
  });
  const output = await readJson(paths.communityPath);
  assert.equal(calls, 0);
  assert.equal(result.outcome, "empty");
  assert.equal(output.sample, false);
  assert.equal(output.datasetState, "no-current-posts");
  assert.deepEqual(output.items, []);
  assert.equal(output.audit.containsPostText, false);
});

test("a successful provider refresh removes prior items no longer returned upstream", async (t) => {
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await seedLiveYouTubeDataset(paths);
  await runCommunityUpdate({
    rootDir,
    now: () => now,
    env: { YOUTUBE_API_KEY: "refresh-secret" },
    fetchImpl: async () => jsonResponse({ items: [] }),
  });
  const output = await readJson(paths.communityPath);
  assert.deepEqual(output.items, []);
  assert.equal(output.sample, false);
  assert.equal(output.datasetState, "no-current-posts");
  assert.equal(JSON.stringify(output).includes("refresh-secret"), false);
});

test("a failed provider refresh preserves that platform's unexpired prior items", async (t) => {
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await seedLiveYouTubeDataset(paths);
  await runCommunityUpdate({
    rootDir,
    now: () => now,
    env: { YOUTUBE_API_KEY: "failure-secret" },
    fetchImpl: async () => jsonResponse({ error: "unavailable" }, 503),
  });
  const output = await readJson(paths.communityPath);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].id, "youtube-previous");
  assert.equal(output.sample, false);
  assert.equal(JSON.stringify(output).includes("failure-secret"), false);
});

test("bundle validation rejects an HTTPS community URL on a non-platform host", async (t) => {
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  const bundle = {
    forecast: await readJson(paths.forecastPath),
    warnings: await readJson(paths.warningsPath),
    news: await readJson(paths.newsPath),
    community: await readJson(paths.communityPath),
    status: await readJson(paths.statusPath),
  };
  bundle.community.items = [{
    id: "bad-host",
    platform: "youtube",
    title: "Weather link on an unapproved host",
    url: "https://not-a-platform.example/weather",
    publishedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    familySafe: true,
    location: { latitude: null, longitude: null },
  }];
  assert.ok(validateBundle(bundle).some((error) => /allowed platform host/.test(error)));
});

test("bundle validation enforces the public community contract beyond URL syntax", async (t) => {
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  const bundle = {
    forecast: await readJson(paths.forecastPath),
    warnings: await readJson(paths.warningsPath),
    news: await readJson(paths.newsPath),
    community: await readJson(paths.communityPath),
    status: await readJson(paths.statusPath),
  };
  bundle.community.sample = false;
  bundle.community.items = [{
    id: "contract-check",
    platform: "youtube",
    author: "Public creator",
    title: "Rain in Manchester",
    excerpt: "A short public weather note.",
    url: "https://www.youtube.com/watch?v=contract-check",
    publishedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    familySafe: true,
    reviewStatus: "pending",
    mediaType: "raw-html",
    location: {
      label: "A street address",
      region: null,
      basis: "street_guess",
      confidence: "certain",
      latitude: null,
      longitude: null,
    },
  }];
  const errors = validateBundle(bundle);
  assert.ok(errors.some((error) => /invalid review status/.test(error)));
  assert.ok(errors.some((error) => /invalid media type/.test(error)));
  assert.ok(errors.some((error) => /invalid location basis/.test(error)));
  assert.ok(errors.some((error) => /invalid location confidence/.test(error)));
});
