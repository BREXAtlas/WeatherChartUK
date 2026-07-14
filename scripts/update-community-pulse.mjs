import { pathToFileURL } from "node:url";
import { createPaths } from "./lib/constants.mjs";
import { asArray, readJson, safeErrorCode, writeJsonAtomic } from "./lib/fs-json.mjs";
import { normaliseCommunityItems } from "./lib/community.mjs";
import { runCommunityAdapters } from "./lib/community-adapters/index.mjs";
import { readStatus, recordSource, writeStatus } from "./lib/status.mjs";

export async function runCommunityUpdate({
  rootDir = process.cwd(),
  now = () => new Date(),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const generatedAt = now();
  const paths = createPaths(rootDir);
  const [status, previous, curated, keywords, allowlist, blocklist] = await Promise.all([
    readStatus(paths.statusPath, generatedAt),
    readJson(paths.communityPath, null),
    readJson(paths.curatedTikTokPath, {}),
    readJson(paths.socialKeywordsPath, {}),
    readJson(paths.socialAllowlistPath, {}),
    readJson(paths.socialBlocklistPath, {}),
  ]);

  const previousItems = asArray(previous, "items");
  const adapters = await runCommunityAdapters({
    env,
    fetchImpl,
    keywords,
    curatedTikTok: curated,
    allowlist,
    blocklist,
    now: generatedAt,
  });
  const liveItems = adapters.items;
  const previousLiveItems = previous?.sample === false ? previousItems : [];
  const adapterByPlatform = new Map(adapters.results.map((result) => [result.platform, result]));
  const preservedPreviousLiveItems = previousLiveItems.filter((item) => {
    const sourceResult = adapterByPlatform.get(item?.platform);
    return !sourceResult || sourceResult.state === "disabled" || sourceResult.state === "error";
  });
  const candidates = [...liveItems, ...preservedPreviousLiveItems];
  const totalCap = Math.max(1, Math.min(Number(keywords?.perPlatformCaps?.total) || 24, 40));
  const items = normaliseCommunityItems(
    candidates,
    { allowlist, blocklist, now: generatedAt },
  ).slice(0, totalCap);

  const hasLiveItems = liveItems.length > 0;
  const hasPreservedLiveItems = preservedPreviousLiveItems.length > 0 && items.length > 0;
  const output = {
    schemaVersion: 1,
    sample: false,
    datasetState: hasLiveItems ? "live-public-posts" : hasPreservedLiveItems ? "preserved-live" : "no-current-posts",
    generatedAt: generatedAt.toISOString(),
    expiresAfterHours: 48,
    notice: "Public posts are shown for local flavour and may be inaccurate. Use the official forecast and warnings for decisions.",
    source: {
      method: "documented public platform APIs, official provider APIs and manually curated public links",
      scrapingUsed: false,
    },
    audit: adapters.audit,
    items,
  };
  await writeJsonAtomic(paths.communityPath, output);
  for (const result of adapters.results) {
    const sourceName = `community-${result.platform}`;
    if (result.state === "disabled") recordSource(status, sourceName, "skipped");
    else if (result.state === "error") recordSource(status, sourceName, "failed", result.errorCode ?? "provider-error");
    else recordSource(status, sourceName, "success");
  }
  recordSource(status, "community-aggregation", "success");
  await writeStatus(paths.statusPath, status, generatedAt);
  return {
    outcome: hasLiveItems ? "live" : hasPreservedLiveItems ? "preserved" : "empty",
    itemCount: items.length,
    audit: adapters.audit,
  };
}

async function main() {
  const result = await runCommunityUpdate();
  console.log(
    `Community update: ${result.outcome}; items: ${result.itemCount}; requests: ${result.audit.requests}; excluded: ${Object.values(result.audit.excluded).reduce((sum, value) => sum + value, 0)}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Community update stopped safely (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
