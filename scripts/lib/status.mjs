import { STALE_AFTER_MS, STRONGLY_STALE_AFTER_MS } from "./constants.mjs";
import { readJson, writeJsonAtomic } from "./fs-json.mjs";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function createStatus(now = new Date(), previous = {}) {
  const generatedAt = now.toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    deployedAt: previous.deployedAt ?? null,
    nextExpectedCheck: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    sourcesChecked: Array.isArray(previous.sourcesChecked) ? previous.sourcesChecked : [],
    successfulSources: Array.isArray(previous.successfulSources) ? previous.successfulSources : [],
    failedSources: Array.isArray(previous.failedSources) ? previous.failedSources : [],
    sourceErrors: previous.sourceErrors && typeof previous.sourceErrors === "object" ? previous.sourceErrors : {},
    provider: previous.provider ?? "sample",
    fallbackUsed: previous.fallbackUsed ?? true,
    stale: previous.stale ?? false,
    staleLevel: previous.staleLevel ?? "fresh",
    warningCount: Number.isInteger(previous.warningCount) ? previous.warningCount : 0,
    workflowRun: process.env.GITHUB_RUN_ID ?? previous.workflowRun ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? previous.workflowAttempt ?? null,
    lastSuccessfulOfficialAt: previous.lastSuccessfulOfficialAt ?? null,
    lastForecastAttemptAt: previous.lastForecastAttemptAt ?? null,
    forecastState: previous.forecastState ?? "sample",
    quota: previous.quota ?? null,
  };
}

export function recordSource(status, source, outcome, errorCode = null) {
  status.sourcesChecked = unique([...status.sourcesChecked, source]);
  if (outcome === "success" || outcome === "skipped") {
    status.successfulSources = unique([...status.successfulSources, source]);
    status.failedSources = status.failedSources.filter((value) => value !== source);
    delete status.sourceErrors[source];
  } else {
    status.failedSources = unique([...status.failedSources, source]);
    status.successfulSources = status.successfulSources.filter((value) => value !== source);
    if (errorCode) status.sourceErrors[source] = errorCode;
  }
  return status;
}

export function staleMetadata(timestamp, now = new Date()) {
  const parsed = Date.parse(timestamp ?? "");
  if (!Number.isFinite(parsed)) return { stale: true, staleLevel: "strong" };
  const age = Math.max(0, now.getTime() - parsed);
  if (age >= STRONGLY_STALE_AFTER_MS) return { stale: true, staleLevel: "strong" };
  if (age >= STALE_AFTER_MS) return { stale: true, staleLevel: "standard" };
  return { stale: false, staleLevel: "fresh" };
}

export async function readStatus(statusPath, now = new Date()) {
  const previous = await readJson(statusPath, {});
  return createStatus(now, previous && typeof previous === "object" ? previous : {});
}

export async function writeStatus(statusPath, status, now = new Date()) {
  const nextExpectedCheck = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const output = {
    ...status,
    generatedAt: now.toISOString(),
    nextExpectedCheck,
    nextCheckAt: nextExpectedCheck,
    sourcesChecked: unique(status.sourcesChecked),
    checkedSources: unique(status.sourcesChecked),
    successfulSources: unique(status.successfulSources),
    failedSources: unique(status.failedSources),
    fallbackActive: Boolean(status.fallbackUsed),
    workflowRunId: status.workflowRun,
  };
  await writeJsonAtomic(statusPath, output);
  return output;
}
