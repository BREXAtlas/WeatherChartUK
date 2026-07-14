import { pathToFileURL } from "node:url";
import {
  MET_OFFICE_NEWS_RSS,
  MET_OFFICE_WARNINGS_RSS,
  REQUEST_TIMEOUT_MS,
  createPaths,
} from "./lib/constants.mjs";
import { asArray, readJson, safeErrorCode, writeJsonAtomic } from "./lib/fs-json.mjs";
import {
  classifyTopics,
  isDirectMetOfficeUrl,
  parseRss,
  warningSeverity,
  wordCount,
} from "./lib/rss.mjs";
import { readStatus, recordSource, writeStatus } from "./lib/status.mjs";

const NEUTRAL_SUMMARY =
  "A new Met Office update is available—read the official source for full details.";

async function fetchRss(url, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error("RSS request failed"), { code: safeErrorCode(error) });
  }
  if (!response?.ok) {
    throw Object.assign(new Error("RSS source returned an error"), {
      code: Number.isInteger(response?.status) ? `rss-http-${response.status}` : "rss-http-error",
    });
  }
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType && !/(?:rss|atom|xml)/i.test(contentType)) {
    throw Object.assign(new Error("RSS source returned an unexpected content type"), {
      code: "rss-content-type-invalid",
    });
  }
  return response.text();
}

export function normaliseCuratedNews(value) {
  const entries = Array.isArray(value?.curatedLinks)
    ? value.curatedLinks
    : asArray(value, "items");
  return entries
    .map((entry) => {
      const reviewedAt = entry?.reviewedAt ?? null;
      const explicitlyApproved = entry?.manuallyReviewed === true
        && Number.isFinite(Date.parse(reviewedAt ?? ""));
      return {
        url: entry?.directSourceUrl ?? entry?.sourceUrl ?? entry?.url ?? entry?.link ?? null,
        title: entry?.title ?? null,
        summary: entry?.editorialSummary ?? entry?.weatherChartSummary ?? entry?.summary ?? null,
        reviewedAt: explicitlyApproved ? reviewedAt : null,
        reviewStatus: explicitlyApproved ? "approved" : "unreviewed",
      };
    })
    .filter(({ url, title }) => isDirectMetOfficeUrl(url) && title);
}

function reviewedSummary(item, curated) {
  const match = curated.find((entry) => entry.url === item.url || entry.title === item.title);
  if (
    match?.reviewStatus === "approved" &&
    match.reviewedAt &&
    wordCount(match.summary) >= 8 &&
    wordCount(match.summary) <= 25
  ) {
    return {
      summary: match.summary.trim(),
      reviewStatus: match.reviewStatus,
      reviewedAt: match.reviewedAt,
    };
  }
  return { summary: NEUTRAL_SUMMARY, reviewStatus: "unreviewed", reviewedAt: null };
}

export function buildWarningsDataset(items, generatedAt = new Date()) {
  const candidates = items.slice(0, 40).map((item) => ({
    item,
    severity: warningSeverity(`${item.title} ${item.description}`),
    validFromMs: Date.parse(item.validFrom ?? ""),
    validUntilMs: Date.parse(item.validUntil ?? ""),
    regions: Array.isArray(item.regions) ? item.regions.map((value) => String(value).trim()).filter(Boolean) : [],
  }));
  const complete = candidates.filter(({ severity, validFromMs, validUntilMs, regions }) =>
    ["yellow", "amber", "red"].includes(severity)
      && Number.isFinite(validFromMs)
      && Number.isFinite(validUntilMs)
      && validUntilMs > validFromMs
      && regions.length > 0
  );
  const warnings = complete.map(({ item, severity, regions }) => ({
    id: item.id,
    severity,
    title: item.title,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    regions,
    description: item.description,
    interpretation: "Read and follow the full official warning for impacts, actions and updates.",
    publishedAt: item.publishedAt,
    sourceUrl: item.url,
    sourceName: "Met Office severe weather warnings RSS",
  }));
  return {
    schemaVersion: 1,
    sample: false,
    datasetState: "live-rss",
    generatedAt: generatedAt.toISOString(),
    source: {
      name: "Met Office severe weather warnings RSS",
      url: MET_OFFICE_WARNINGS_RSS,
      termsUrl: "https://weather.metoffice.gov.uk/guides/rss",
      attribution: "Met Office",
    },
    omittedIncompleteCount: candidates.length - complete.length,
    warnings,
  };
}

export function buildNewsDataset(items, curated, generatedAt = new Date()) {
  const normalised = items.slice(0, 30).map((item) => {
    const review = reviewedSummary(item, curated);
    const topics = classifyTopics(`${item.title} ${item.description}`);
    return {
      id: item.id,
      title: item.title,
      publishedAt: item.publishedAt,
      url: item.url,
      topic: topics[0],
      topics,
      summary: review.summary,
      wordCount: wordCount(review.summary),
      summaryLabel: "WeatherChart’s plain-English take",
      reviewStatus: review.reviewStatus,
      reviewedAt: review.reviewedAt,
      sourceName: "Met Office News Releases RSS",
    };
  });
  return {
    schemaVersion: 1,
    sample: false,
    datasetState: "live-rss",
    generatedAt: generatedAt.toISOString(),
    source: {
      name: "Met Office News Releases RSS",
      url: MET_OFFICE_NEWS_RSS,
      termsUrl: "https://weather.metoffice.gov.uk/guides/rss",
      attribution: "Met Office",
    },
    items: normalised,
  };
}

function emptyWarnings(now) {
  return {
    ...buildWarningsDataset([], now),
    sample: false,
    unavailable: true,
    datasetState: "source-unavailable",
  };
}

function emptyNews(now) {
  return {
    ...buildNewsDataset([], [], now),
    sample: false,
    unavailable: true,
    datasetState: "source-unavailable",
  };
}

export async function runNewsUpdate({
  rootDir = process.cwd(),
  now = () => new Date(),
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  warningsRssUrl = process.env.MET_OFFICE_WARNINGS_RSS_URL || MET_OFFICE_WARNINGS_RSS,
  newsRssUrl = process.env.MET_OFFICE_NEWS_RSS_URL || MET_OFFICE_NEWS_RSS,
} = {}) {
  const generatedAt = now();
  const paths = createPaths(rootDir);
  const status = await readStatus(paths.statusPath, generatedAt);
  const curated = normaliseCuratedNews(await readJson(paths.curatedNewsPath, []));
  const outcomes = {};

  try {
    const warningItems = parseRss(await fetchRss(warningsRssUrl, fetchImpl, timeoutMs));
    const warnings = buildWarningsDataset(warningItems, generatedAt);
    if (warnings.omittedIncompleteCount > 0) {
      throw Object.assign(new Error("Warning feed items lack validated timing, severity, or affected regions"), {
        code: "warning-feed-incomplete",
      });
    }
    await writeJsonAtomic(paths.warningsPath, warnings);
    status.warningCount = warnings.warnings.length;
    recordSource(status, "met-office-warnings-rss", "success");
    outcomes.warnings = "updated";
  } catch (error) {
    const previous = await readJson(paths.warningsPath, null);
    if (!previous || previous.sample !== false || !Array.isArray(previous.warnings)) {
      await writeJsonAtomic(paths.warningsPath, emptyWarnings(generatedAt));
      status.warningCount = 0;
      outcomes.warnings = "unavailable";
    } else {
      status.warningCount = previous.warnings.length;
      outcomes.warnings = "preserved";
    }
    recordSource(status, "met-office-warnings-rss", "failure", safeErrorCode(error));
  }

  try {
    const newsItems = parseRss(await fetchRss(newsRssUrl, fetchImpl, timeoutMs));
    const news = buildNewsDataset(newsItems, curated, generatedAt);
    await writeJsonAtomic(paths.newsPath, news);
    recordSource(status, "met-office-news-rss", "success");
    outcomes.news = "updated";
  } catch (error) {
    const previous = await readJson(paths.newsPath, null);
    if (!previous || previous.sample !== false || !Array.isArray(previous.items)) {
      await writeJsonAtomic(paths.newsPath, emptyNews(generatedAt));
      outcomes.news = "unavailable";
    } else {
      outcomes.news = "preserved";
    }
    recordSource(status, "met-office-news-rss", "failure", safeErrorCode(error));
  }

  await writeStatus(paths.statusPath, status, generatedAt);
  return outcomes;
}

async function main() {
  const result = await runNewsUpdate();
  console.log(`RSS update: warnings ${result.warnings}; news ${result.news}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`RSS update stopped safely (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
