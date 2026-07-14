import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { runWeatherUpdate } from "../scripts/update-weather-data.mjs";
import { DEFAULT_LOCATIONS } from "../scripts/lib/constants.mjs";
import { readJson, writeJsonAtomic } from "../scripts/lib/fs-json.mjs";
import { normaliseMetOfficeForecast } from "../scripts/lib/weather.mjs";
import { removeRoot, seedPrivateLedger, temporaryRoot } from "./helpers.mjs";

const fixtureUrl = new URL("./fixtures/metoffice-hourly.json", import.meta.url);
const fixture = JSON.parse(await fs.readFile(fixtureUrl, "utf8"));

function openMeteoFixture(now) {
  const times = Array.from({ length: 30 }, (_, index) =>
    new Date(now.getTime() + index * 3_600_000).toISOString().slice(0, 16));
  return {
    latitude: 51.5,
    longitude: -0.1,
    hourly: {
      time: times,
      temperature_2m: times.map((_, index) => 14 + (index % 7)),
      apparent_temperature: times.map((_, index) => 13 + (index % 7)),
      precipitation_probability: times.map(() => 20),
      precipitation: times.map(() => 0),
      relative_humidity_2m: times.map(() => 72),
      wind_speed_10m: times.map(() => 16),
      wind_gusts_10m: times.map(() => 25),
      wind_direction_10m: times.map(() => 225),
      visibility: times.map(() => 10_000),
      pressure_msl: times.map(() => 1014),
      weather_code: times.map(() => 2),
      cloud_cover: times.map(() => 45),
      dew_point_2m: times.map(() => 10),
    },
  };
}

test("Met Office GeoJSON is normalised with explicit conversions and source metadata", () => {
  const result = normaliseMetOfficeForecast(
    fixture,
    DEFAULT_LOCATIONS[0],
    new Date("2026-07-13T16:05:00Z"),
  );
  assert.equal(result.current.temperatureC, 20.9);
  assert.equal(result.current.precipitationProbability, 45);
  assert.equal(result.current.windKph, 19.8);
  assert.equal(result.current.pressureHpa, 1012.8);
  assert.equal(result.current.condition, "Light rain");
  assert.equal(result.sourcePoint.name, "London");
  assert.match(result.sourcePoint.licence, /OpenStreetMap/);
});

test("a complete official batch uses hourly endpoints and the apikey header only", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.generatedAt = now.toISOString();
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  const seen = [];
  const testKey = "unit-test-placeholder";
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => fixture };
  };

  const result = await runWeatherUpdate({ rootDir, now: () => now, fetchImpl, apiKey: testKey });
  assert.equal(result.outcome, "updated");
  assert.equal(result.attemptsThisRun, 12);
  assert.equal(seen.length, 12);
  for (const request of seen) {
    assert.match(request.url, /\/point\/hourly\?/);
    assert.doesNotMatch(request.url, /unit-test-placeholder/);
    assert.equal(request.options.headers.apikey, testKey);
    assert.equal(request.options.redirect, "error");
  }
  const generated = await readJson(paths.forecastPath);
  assert.equal(generated.sample, false);
  assert.equal(generated.locations.length, 12);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 12);
});

test("a missing Met Office credential publishes a fresh attributed Open-Meteo batch", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  let metOfficeCalls = 0;
  let fallbackCalls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "",
    requireLiveForecast: true,
    fetchImpl: async () => {
      metOfficeCalls += 1;
      throw new Error("Met Office should not be called without a credential");
    },
    fallbackFetchImpl: async (url, options) => {
      fallbackCalls += 1;
      assert.match(String(url), /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
      assert.equal(options.headers.apikey, undefined);
      return { ok: true, status: 200, json: async () => openMeteoFixture(now) };
    },
  });
  assert.equal(result.outcome, "credential-not-configured");
  assert.equal(result.fallbackUpdated, true);
  assert.equal(metOfficeCalls, 0);
  assert.equal(fallbackCalls, 12);
  const forecast = await readJson(paths.forecastPath);
  assert.equal(forecast.sample, false);
  assert.equal(forecast.fallback, true);
  assert.equal(forecast.source.id, "open-meteo-forecast");
  assert.equal(forecast.locations.length, 12);
  assert.equal(forecast.locations.every(({ hourly }) => hourly.length === 24), true);
  const updatedStatus = await readJson(paths.statusPath);
  assert.equal(updatedStatus.provider.mode, "indicative-fallback");
  assert.equal(updatedStatus.forecastState, "live-fallback");
  assert.equal(updatedStatus.quota.attempts, 0);
});

test("a failed request is not retried and the pre-reserved batch preserves the last valid forecast", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths, forecast } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "request-failed");
  assert.equal(calls, 1);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 12);
  const updatedStatus = await readJson(paths.statusPath);
  assert.equal(updatedStatus.quota.callsMadeThisRun, 1);
  assert.equal(updatedStatus.quota.reservedCallsThisRun, 12);
  assert.deepEqual(await readJson(paths.forecastPath), forecast);
});

test("a failed refresh labels preserved official data as cached rather than current live", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T12:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const prior = await readJson(paths.forecastPath);
  prior.sample = false;
  prior.fallback = false;
  prior.generatedAt = "2026-07-13T12:00:00.000Z";
  prior.source = { id: "met-office-global-spot-hourly", name: "Met Office Weather DataHub" };
  await writeJsonAtomic(paths.forecastPath, prior);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  status.lastSuccessfulOfficialAt = prior.generatedAt;
  await writeJsonAtomic(paths.statusPath, status);

  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(result.outcome, "request-failed");
  const updatedStatus = await readJson(paths.statusPath);
  assert.equal(updatedStatus.provider.mode, "cached");
  assert.equal(updatedStatus.fallbackUsed, true);
  assert.equal(updatedStatus.forecastState, "last-valid-preserved");
  assert.equal((await readJson(paths.forecastPath)).sample, false);
});

test("required durable quota is confirmed as one batch before the first upstream request", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);

  let confirmed = false;
  let reserveCalls = 0;
  const durableQuotaStore = {
    async reserveBatch({ size, minimumAttempts }) {
      reserveCalls += 1;
      assert.equal(size, 12);
      assert.equal(minimumAttempts, 0);
      confirmed = true;
      return {
        confirmed: true,
        durable: true,
        utcDay: "2026-07-13",
        limit: 350,
        attempts: 12,
        attemptsBefore: 0,
        attemptsAfter: 12,
        reserved: 12,
        reservationId: "test-run:1",
        reservedAt: now.toISOString(),
      };
    },
  };
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore,
    fetchImpl: async () => {
      assert.equal(confirmed, true);
      calls += 1;
      return { ok: true, status: 200, json: async () => fixture };
    },
  });

  assert.equal(result.outcome, "updated");
  assert.equal(reserveCalls, 1);
  assert.equal(calls, 12);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 12);
  const updatedStatus = await readJson(paths.statusPath);
  assert.equal(updatedStatus.quota.callsMadeThisRun, 12);
  assert.equal(updatedStatus.quota.reservedCallsThisRun, 12);
  assert.equal(updatedStatus.quota.reservationMode, "github-contents-cas");
});

test("required durable reservation failure stops before all Met Office requests", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: {
      async reserveBatch() {
        throw Object.assign(new Error("unavailable"), { code: "durable-quota-write-unconfirmed" });
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => fixture };
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "durable-quota-write-unconfirmed");
  assert.equal(result.attemptsThisRun, 0);
  assert.equal(calls, 0);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 0);
});

test("fresh official data skips manual, push, and scheduled duplicate calls for 55 minutes", async (t) => {
  const now = new Date("2026-07-13T18:40:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T18:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 120);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  status.lastSuccessfulOfficialAt = "2026-07-13T18:00:00Z";
  await writeJsonAtomic(paths.statusPath, status);
  const sample = await readJson(paths.forecastPath);
  sample.sample = false;
  sample.fallback = false;
  sample.generatedAt = "2026-07-13T18:00:00Z";
  sample.source = { id: "met-office-global-spot-hourly", name: "Met Office Weather DataHub" };
  await writeJsonAtomic(paths.forecastPath, sample);
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    fetchImpl: async () => { calls += 1; },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "freshness-skip");
  assert.equal(calls, 0);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 120);
});

test("an eleven-call remainder stops before any upstream request", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 339);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    fetchImpl: async () => { calls += 1; },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "fewer-than-12-calls-remain");
  assert.equal(calls, 0);
});

test("the UTC-boundary safety window stops before reservation and upstream I/O", async (t) => {
  const now = new Date("2026-07-13T23:58:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T21:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  let reservations = 0;
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: {
      async reserveBatch() { reservations += 1; },
    },
    fetchImpl: async () => { calls += 1; },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "utc-boundary-safety-window");
  assert.equal(reservations, 0);
  assert.equal(calls, 0);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 0);
});
