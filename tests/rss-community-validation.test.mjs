import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DATA_FILE_NAMES } from "../scripts/lib/constants.mjs";
import { normaliseCommunityItems, sanitisePublicUrl } from "../scripts/lib/community.mjs";
import { parseRss, wordCount } from "../scripts/lib/rss.mjs";
import {
  buildNewsDataset,
  buildWarningsDataset,
  normaliseCuratedNews,
  runNewsUpdate,
} from "../scripts/update-metoffice-news.mjs";
import { validateBundle, validateGeneratedData } from "../scripts/validate-generated-data.mjs";
import { temporaryRoot, removeRoot, seedPrivateLedger } from "./helpers.mjs";
import { readJson, writeJsonAtomic } from "../scripts/lib/fs-json.mjs";

const warningXml = await fs.readFile(new URL("./fixtures/warnings-rss.xml", import.meta.url), "utf8");
const newsXml = await fs.readFile(new URL("./fixtures/news-rss.xml", import.meta.url), "utf8");
const socialBlocklist = JSON.parse(await fs.readFile(new URL("../weatherchart/config/social-blocklist.json", import.meta.url), "utf8"));

test("RSS parsing preserves direct Met Office links and rejects intermediate hosts", () => {
  const warnings = parseRss(warningXml);
  const news = parseRss(newsXml);
  assert.equal(warnings.length, 2);
  assert.equal(news.length, 1);
  assert.equal(news[0].url, "https://www.metoffice.gov.uk/about-us/news-and-media/media-centre/weather-and-climate-news/2026/example");
  const warning = buildWarningsDataset(warnings).warnings.find(({ severity }) => severity === "yellow");
  assert.equal(warning.severity, "yellow");
  assert.equal(warning.validFrom, "2026-07-13T13:00:00.000Z");
  assert.equal(warning.validUntil, "2026-07-14T06:00:00.000Z");
  assert.deepEqual(warning.regions, ["North West England", "Wales"]);
});

test("RSS parsing supports the Met Office human-readable warning validity and area format", () => {
  const parsed = parseRss(warningXml).find(({ title }) => title.startsWith("Amber warning"));
  assert.equal(parsed.validFrom, "2026-06-25T22:00:00.000Z");
  assert.equal(parsed.validUntil, "2026-06-26T21:59:00.000Z");
  assert.deepEqual(parsed.regions, ["Gloucestershire"]);
  const dataset = buildWarningsDataset([parsed], new Date("2026-06-26T15:00:00Z"));
  assert.equal(dataset.omittedIncompleteCount, 0);
  assert.equal(dataset.warnings.length, 1);
  assert.equal(dataset.warnings[0].severity, "amber");
});

test("RSS parsing rejects non-feed XML and incomplete warning items", () => {
  assert.throws(() => parseRss("<html><body>service error</body></html>"), /feed root/i);
  const incomplete = parseRss(`<?xml version="1.0"?><rss><channel><title>Met Office warnings</title><item>
    <title>Amber warning of wind</title>
    <link>https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings/incomplete</link>
    <description>Timing is available only on the official warning page.</description>
  </item></channel></rss>`);
  const dataset = buildWarningsDataset(incomplete, new Date("2026-07-13T18:00:00Z"));
  assert.equal(dataset.warnings.length, 0);
  assert.equal(dataset.omittedIncompleteCount, 1);
});

test("warning updater publishes complete feed items and fails closed on malformed content", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const first = await temporaryRoot(now);
  const second = await temporaryRoot(now);
  t.after(() => Promise.all([removeRoot(first.rootDir), removeRoot(second.rootDir)]));
  const response = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/rss+xml" },
    text: async () => body,
  });

  await runNewsUpdate({
    rootDir: first.rootDir,
    now: () => now,
    fetchImpl: async (url) => response(String(url).includes("WarningsRSS") ? warningXml : newsXml),
  });
  const published = await readJson(first.paths.warningsPath);
  assert.equal(published.sample, false);
  assert.equal(published.warnings.length, 2);
  assert.equal((await readJson(first.paths.statusPath)).successfulSources.includes("met-office-warnings-rss"), true);

  await runNewsUpdate({
    rootDir: second.rootDir,
    now: () => now,
    fetchImpl: async (url) => response(String(url).includes("WarningsRSS") ? "<html>temporary error</html>" : newsXml),
  });
  const unavailable = await readJson(second.paths.warningsPath);
  const status = await readJson(second.paths.statusPath);
  assert.equal(unavailable.sample, false);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.datasetState, "source-unavailable");
  assert.equal(unavailable.warnings.length, 0);
  assert.equal(status.failedSources.includes("met-office-warnings-rss"), true);
});

test("unreviewed news receives a neutral 8–25 word summary", () => {
  const dataset = buildNewsDataset(parseRss(newsXml), [], new Date("2026-07-13T18:00:00Z"));
  assert.equal(dataset.items.length, 1);
  assert.equal(dataset.items[0].reviewStatus, "unreviewed");
  assert.ok(wordCount(dataset.items[0].summary) >= 8);
  assert.ok(wordCount(dataset.items[0].summary) <= 25);
});

test("curatedLinks metadata applies reviewed summaries from the committed config schema", () => {
  const item = parseRss(newsXml)[0];
  const curated = normaliseCuratedNews({
    curatedLinks: [{
      title: item.title,
      directSourceUrl: item.url,
      editorialSummary: "Official forecasters outline the expected weather pattern and direct readers to current guidance.",
      manuallyReviewed: true,
      reviewedAt: "2026-07-13T17:00:00Z",
    }],
  });
  const dataset = buildNewsDataset([item], curated, new Date("2026-07-13T18:00:00Z"));
  assert.equal(dataset.items[0].reviewStatus, "approved");
  assert.equal(dataset.items[0].summary, curated[0].summary);
  assert.equal(dataset.items[0].reviewedAt, "2026-07-13T17:00:00Z");
});

test("curated news requires explicit manual review and a review timestamp", () => {
  const item = parseRss(newsXml)[0];
  const summary = "This confident editorial wording must not publish until a human reviewer explicitly approves it.";
  const cases = [
    { title: item.title, directSourceUrl: item.url, editorialSummary: summary },
    { title: item.title, directSourceUrl: item.url, editorialSummary: summary, manuallyReviewed: true },
    { title: item.title, directSourceUrl: item.url, editorialSummary: summary, manuallyReviewed: false, reviewedAt: "2026-07-13T17:00:00Z" },
  ];
  for (const candidate of cases) {
    const curated = normaliseCuratedNews({ curatedLinks: [candidate] });
    const dataset = buildNewsDataset([item], curated, new Date("2026-07-13T18:00:00Z"));
    assert.equal(dataset.items[0].reviewStatus, "unreviewed");
    assert.notEqual(dataset.items[0].summary, summary);
  }
});

test("community normalisation allowlists HTTPS domains and strips precise coordinates", () => {
  assert.equal(sanitisePublicUrl("javascript:alert(1)"), null);
  assert.equal(sanitisePublicUrl("https://example.test/post"), null);
  const items = normaliseCommunityItems([
    {
      url: "https://bsky.app/profile/example/post/1?utm_source=test",
      title: "Rain over Glasgow",
      excerpt: "A brief public weather comment.",
      publishedAt: "2026-07-13T17:00:00Z",
      expiresAt: "2026-07-14T17:00:00Z",
      familySafe: true,
      location: { name: "Glasgow", latitude: 55.8642, longitude: -4.2518, basis: "author_explicit", confidence: "medium" },
    },
  ], { now: new Date("2026-07-13T18:00:00Z") });
  assert.equal(items.length, 1);
  assert.equal(items[0].location.latitude, null);
  assert.equal(items[0].location.longitude, null);
});

test("community items cannot be extended beyond 48 hours after publication", () => {
  const items = normaliseCommunityItems([
    {
      url: "https://bsky.app/profile/example/post/expiry",
      title: "Rain clearing in western Scotland",
      excerpt: "A short public weather observation.",
      publishedAt: "2026-07-13T12:00:00Z",
      expiresAt: "2026-07-20T12:00:00Z",
      familySafe: true,
    },
  ], { now: new Date("2026-07-13T18:00:00Z") });
  assert.equal(items.length, 1);
  assert.equal(items[0].expiresAt, "2026-07-15T12:00:00.000Z");

  const expired = normaliseCommunityItems([
    {
      url: "https://bsky.app/profile/example/post/stale",
      title: "An old weather observation",
      excerpt: "This item must not be revived by a later pipeline run.",
      publishedAt: "2026-07-10T12:00:00Z",
      familySafe: true,
    },
  ], { now: new Date("2026-07-13T18:00:00Z") });
  assert.deepEqual(expired, []);
});

test("community normalisation rejects profanity and deduplicates canonical URLs", () => {
  const base = {
    url: "https://bsky.app/profile/example/post/duplicate?utm_source=one",
    title: "Rain clearing over Glasgow",
    excerpt: "A short public weather note.",
    publishedAt: "2026-07-13T17:00:00Z",
    familySafe: true,
  };
  const duplicates = normaliseCommunityItems([
    base,
    { ...base, url: "https://bsky.app/profile/example/post/duplicate?utm_source=one" },
  ], { now: new Date("2026-07-13T18:00:00Z"), blocklist: socialBlocklist });
  assert.equal(duplicates.length, 1);

  const blocked = normaliseCommunityItems([
    { ...base, url: "https://bsky.app/profile/example/post/blocked", excerpt: "This forecast is bullshit." },
  ], { now: new Date("2026-07-13T18:00:00Z"), blocklist: socialBlocklist });
  assert.deepEqual(blocked, []);
});

test("whole-bundle validation accepts the sample contract and rejects credential fields", async (t) => {
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T18:00:00Z"));
  t.after(() => removeRoot(rootDir));
  const bundle = {
    forecast: await readJson(paths.forecastPath),
    warnings: await readJson(paths.warningsPath),
    news: await readJson(paths.newsPath),
    community: await readJson(paths.communityPath),
    status: await readJson(paths.statusPath),
  };
  assert.deepEqual(validateBundle(bundle), []);
  bundle.forecast.apiKey = "must-never-ship";
  assert.ok(validateBundle(bundle).some((error) => /forbidden credential field/.test(error)));
});

test("restoring last-valid data never rolls back already reserved quota attempts", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await fs.mkdir(paths.lastValidDir, { recursive: true });
  for (const fileName of DATA_FILE_NAMES) {
    await fs.copyFile(path.join(paths.dataDir, fileName), path.join(paths.lastValidDir, fileName));
  }

  const status = await readJson(paths.statusPath);
  status.quota = {
    utcDay: "2026-07-13",
    quotaDayUtc: "2026-07-13",
    attempts: 12,
    callsUsed: 12,
    limit: 350,
    limitPerUtcDay: 350,
    callsMadeThisRun: 12,
    updatedAt: now.toISOString(),
    hardStopEnabled: true,
    safe: true,
  };
  await writeJsonAtomic(paths.statusPath, status);
  await seedPrivateLedger(paths, now, 12);
  await writeJsonAtomic(paths.communityPath, { generatedAt: "not-a-date", items: "invalid" });

  const result = await validateGeneratedData({ rootDir, restoreOnFailure: true, now });
  assert.equal(result.restored, true);
  const restoredStatus = await readJson(paths.statusPath);
  assert.equal(restoredStatus.quota.attempts, 12);
  assert.equal(restoredStatus.quota.callsUsed, 12);
  assert.equal(restoredStatus.quota.callsMadeThisRun, 12);
});
