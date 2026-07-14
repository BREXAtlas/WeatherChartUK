import { pathToFileURL } from "node:url";
import { DATA_FILE_NAMES, REQUEST_TIMEOUT_MS, createPaths } from "./lib/constants.mjs";
import { safeErrorCode, writeJsonAtomic } from "./lib/fs-json.mjs";

const DEFAULT_BASE = "https://brexatlas.github.io/WeatherChartUK/data/";
const MAX_DATA_FILE_BYTES = 2_000_000;

function safeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("The deployed-data base must use HTTPS");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url;
}

export async function restoreDeployedData({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  baseUrl = process.env.WEATHERCHART_DEPLOYED_DATA_BASE || DEFAULT_BASE,
} = {}) {
  const base = safeBaseUrl(baseUrl);
  const restored = new Map();
  try {
    for (const fileName of DATA_FILE_NAMES) {
      const url = new URL(fileName, base);
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) throw Object.assign(new Error("Deployed data unavailable"), { code: `restore-http-${response?.status}` });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_DATA_FILE_BYTES) throw new Error("Deployed data file is too large");
      restored.set(fileName, JSON.parse(text));
    }
  } catch (error) {
    return { outcome: "preserved", reason: safeErrorCode(error), count: 0 };
  }

  const paths = createPaths(rootDir);
  for (const [fileName, value] of restored) {
    await writeJsonAtomic(`${paths.dataDir}/${fileName}`, value);
  }
  return { outcome: "restored", reason: null, count: restored.size };
}

async function main() {
  const result = await restoreDeployedData();
  console.log(`Deployed data restore: ${result.outcome}; files: ${result.count}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Deployed data restore stopped safely (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
