import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { DEFAULT_LOCATIONS } from "../scripts/lib/constants.mjs";
import { MetOfficeProvider, MockProvider, OpenMeteoFallbackProvider } from "../scripts/lib/providers.mjs";

const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/metoffice-hourly.json", import.meta.url), "utf8"));

test("MetOfficeProvider keeps the credential in the apikey header and returns the common contract", async () => {
  const seen = [];
  const provider = new MetOfficeProvider({
    apiKey: "unit-test-placeholder",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => fixture };
    },
  });
  const result = await provider.fetchLocation(DEFAULT_LOCATIONS[0], new Date("2026-07-13T16:05:00Z"));
  assert.equal(result.id, "london");
  assert.equal(result.current.temperatureC, 20.9);
  assert.doesNotMatch(seen[0].url, /unit-test-placeholder/);
  assert.equal(seen[0].options.headers.apikey, "unit-test-placeholder");
  assert.equal(provider.id, "met-office-global-spot-hourly");
});

test("MockProvider implements the same per-location contract without a network call", async () => {
  const result = await new MockProvider().fetchLocation(DEFAULT_LOCATIONS[1], new Date("2026-07-13T18:00:00Z"));
  assert.equal(result.id, DEFAULT_LOCATIONS[1].id);
  assert.ok(Array.isArray(result.hourly));
  assert.ok(result.current);
});

test("OpenMeteoFallbackProvider is opt-in and labels its provider mode", async () => {
  const disabled = new OpenMeteoFallbackProvider();
  await assert.rejects(() => disabled.fetchLocation(DEFAULT_LOCATIONS[0]), { code: "open-meteo-fallback-disabled" });

  const provider = new OpenMeteoFallbackProvider({
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        latitude: 51.5,
        longitude: -0.1,
        hourly: {
          time: ["2026-07-13T18:00"],
          temperature_2m: [19], apparent_temperature: [18], precipitation_probability: [40],
          precipitation: [0.2], relative_humidity_2m: [70], wind_speed_10m: [15],
          wind_gusts_10m: [28], wind_direction_10m: [220], visibility: [10000],
          pressure_msl: [1012], weather_code: [61], cloud_cover: [75], dew_point_2m: [12],
        },
      }),
    }),
  });
  const result = await provider.fetchLocation(DEFAULT_LOCATIONS[0], new Date("2026-07-13T17:00:00Z"));
  assert.equal(provider.mode, "indicative-fallback");
  assert.equal(result.current.visibilityKm, 10);
  assert.equal(result.current.condition, "Rain");
  assert.equal(result.hourly.length, 1);
  assert.equal(result.daily.length, 1);
});

test("Open-Meteo keeps the next 24 hours while retaining multi-day summaries", async () => {
  const start = new Date("2026-07-13T18:00:00Z");
  const times = Array.from({ length: 54 }, (_, index) =>
    new Date(start.getTime() + index * 3_600_000).toISOString().slice(0, 16));
  const provider = new OpenMeteoFallbackProvider({
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        latitude: 51.5,
        longitude: -0.1,
        hourly: {
          time: times,
          temperature_2m: times.map((_, index) => 15 + (index % 8)),
          weather_code: times.map(() => 3),
        },
      }),
    }),
  });
  const result = await provider.fetchLocation(DEFAULT_LOCATIONS[0], start);
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly[0].time, start.toISOString());
  assert.ok(result.daily.length >= 3);
  assert.ok(result.daily.every(({ condition }) => condition === "Overcast"));
});
