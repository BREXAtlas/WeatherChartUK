import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOCATIONS, createPaths } from "../scripts/lib/constants.mjs";
import { writeJsonAtomic } from "../scripts/lib/fs-json.mjs";
import { buildMockForecast } from "../scripts/lib/weather.mjs";

export async function temporaryRoot(now = new Date("2026-07-13T18:00:00Z")) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "weatherchart-tests-"));
  const paths = createPaths(rootDir);
  await writeJsonAtomic(paths.locationsPath, { locations: DEFAULT_LOCATIONS });
  const forecast = buildMockForecast(DEFAULT_LOCATIONS, now);
  await writeJsonAtomic(paths.forecastPath, forecast);
  await writeJsonAtomic(paths.warningsPath, {
    sample: true,
    generatedAt: now.toISOString(),
    source: { name: "Sample", url: "https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings" },
    warnings: [],
  });
  await writeJsonAtomic(paths.newsPath, {
    sample: true,
    generatedAt: now.toISOString(),
    source: { name: "Sample", url: "https://www.metoffice.gov.uk/about-us/news-and-media" },
    items: [],
  });
  await writeJsonAtomic(paths.communityPath, {
    schemaVersion: 1,
    sample: false,
    datasetState: "no-current-posts",
    generatedAt: now.toISOString(),
    source: { method: "test public sources", scrapingUsed: false },
    items: [],
  });
  await writeJsonAtomic(paths.statusPath, {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    deployedAt: null,
    nextExpectedCheck: new Date(now.getTime() + 3_600_000).toISOString(),
    sourcesChecked: [],
    successfulSources: [],
    failedSources: [],
    provider: { id: "mock", name: "MockProvider", mode: "sample" },
    fallbackUsed: true,
    stale: false,
    staleLevel: "fresh",
    warningCount: 0,
    quota: quotaFor(now, 0),
  });
  return { rootDir, paths, forecast };
}

export function quotaFor(now, attempts) {
  return {
    version: 1,
    utcDay: now.toISOString().slice(0, 10),
    attempts,
    limit: 350,
    updatedAt: now.toISOString(),
    lastAttemptAt: null,
    source: "test",
  };
}

export async function seedPrivateLedger(paths, now, attempts) {
  await writeJsonAtomic(paths.quotaLedgerPath, quotaFor(now, attempts));
}

export async function removeRoot(rootDir) {
  await fs.rm(rootDir, { recursive: true, force: true });
}
