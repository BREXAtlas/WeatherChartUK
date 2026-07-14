import { pathToFileURL } from "node:url";
import { createGitHubQuotaStoreFromEnvironment } from "./lib/durable-quota-store.mjs";
import { safeErrorCode } from "./lib/fs-json.mjs";

export async function bootstrapWeatherQuota({
  day = process.env.WEATHERCHART_BOOTSTRAP_UTC_DAY ?? "",
  attemptsRaw = process.env.WEATHERCHART_BOOTSTRAP_ATTEMPTS ?? "",
  confirmed = process.env.WEATHERCHART_BOOTSTRAP_CONFIRMED === "true",
  store = createGitHubQuotaStoreFromEnvironment(),
} = {}) {
  if (!confirmed) {
    throw Object.assign(new Error("Explicit quota bootstrap confirmation is required"), {
      code: "quota-bootstrap-not-confirmed",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw Object.assign(new Error("A current UTC day is required"), {
      code: "quota-bootstrap-day-invalid",
    });
  }
  if (!/^\d{1,3}$/.test(String(attemptsRaw))) {
    throw Object.assign(new Error("A confirmed integer call count is required"), {
      code: "quota-bootstrap-count-invalid",
    });
  }
  if (!store) {
    throw Object.assign(new Error("Durable quota storage is not configured"), {
      code: "durable-quota-not-configured",
    });
  }
  const result = await store.bootstrapCurrentDay({ day, attempts: Number(attemptsRaw) });
  return result;
}

async function main() {
  const result = await bootstrapWeatherQuota();
  console.log(
    `Quota bootstrap confirmed for ${result.day}; recorded attempts: ${result.attempts}; hard limit: ${result.limit}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Quota bootstrap stopped safely (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
