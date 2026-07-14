import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { conditionPresentation, interpretationsFor } from "../weatherchart/assets/js/forecast.js";
import { getFreshness } from "../weatherchart/assets/js/api.js";
import { currentCommunityItems, nearestForecastPeriod } from "../weatherchart/assets/js/community.js";
import { geocodeUkQuery, nearestLocation } from "../weatherchart/assets/js/location-search.js";
import { newsDisplayState } from "../weatherchart/assets/js/news.js";
import { DEFAULT_LOCATIONS } from "../scripts/lib/constants.mjs";
import { deriveDaily, normaliseMetOfficeForecast } from "../scripts/lib/weather.mjs";

const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/metoffice-hourly.json", import.meta.url), "utf8"));

test("postcode and town geocoders return only coarse coordinates for nearest-point matching", async () => {
  const seen = [];
  const postcode = await geocodeUkQuery("SW1A 1AA", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return {
        ok: true,
        json: async () => ({ result: { latitude: 51.501, longitude: -0.141, admin_district: "Westminster" } }),
      };
    },
  });
  assert.equal(postcode.sourceName, "postcodes.io");
  assert.match(seen[0], /^https:\/\/api\.postcodes\.io\/postcodes\//);
  assert.equal(nearestLocation(DEFAULT_LOCATIONS, postcode.latitude, postcode.longitude).location.id, "london");

  const town = await geocodeUkQuery("Test-on-Sea", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return {
        ok: true,
        json: async () => ({ results: [{ name: "Test-on-Sea", admin1: "England", country_code: "GB", latitude: 52.63, longitude: 1.3 }] }),
      };
    },
  });
  assert.equal(town.sourceName, "Open-Meteo geocoding");
  assert.match(seen[1], /countryCode=GB/);
});

test("community comparison selects the nearest period on the post's UK calendar date", () => {
  const forecast = {
    hourly: [
      { time: "2026-07-13T22:00:00Z", temperatureC: 12 },
      { time: "2026-07-14T00:00:00Z", temperatureC: 10 },
      { time: "2026-07-14T11:00:00Z", temperatureC: 18 },
    ],
  };
  const period = nearestForecastPeriod({ publishedAt: "2026-07-14T00:20:00Z" }, forecast);
  assert.equal(period.time, "2026-07-14T00:00:00Z");
});

test("community display and map omit expired or non-live cards", () => {
  const checkedAt = new Date("2026-07-13T18:00:00Z");
  const base = {
    familySafe: true,
    reviewStatus: "automated-filtered",
    publishedAt: "2026-07-13T17:00:00Z",
  };
  const items = currentCommunityItems({
    sample: false,
    items: [
      { ...base, id: "current", expiresAt: "2026-07-14T17:00:00Z" },
      { ...base, id: "expired", expiresAt: "2026-07-13T17:30:00Z" },
      { ...base, id: "blocked", expiresAt: "2026-07-14T17:00:00Z", reviewStatus: "blocked" },
    ],
  }, checkedAt);
  assert.deepEqual(items.map(({ id }) => id), ["current"]);
  assert.deepEqual(currentCommunityItems({ sample: true, items: [{ ...base, id: "sample", expiresAt: "2026-07-14T17:00:00Z" }] }, checkedAt), []);
});

test("serious-warning interpretation removes playful copy and animated scene choices", () => {
  const cards = interpretationsFor({ current: { feelsLikeC: 5, gustKph: 60 }, hourly: [] }, { suppressHumour: true });
  assert.equal(cards.length, 8);
  assert.ok(cards.every((card) => card.icon === "!"));
  assert.ok(cards.every((card) => !/cuppa|hair|soggy|brolly|sofa/i.test(card.text)));
  assert.equal(conditionPresentation("Thunder showers").scene, "lightning");
});

test("normalisation preserves unavailable visibility and daily precipitation as null", () => {
  const withoutVisibility = structuredClone(fixture);
  withoutVisibility.features[0].properties.timeSeries.forEach((period) => {
    delete period.visibility;
    delete period.totalPrecipAmount;
  });
  const normalised = normaliseMetOfficeForecast(withoutVisibility, DEFAULT_LOCATIONS[0], new Date("2026-07-13T16:05:00Z"));
  assert.equal(normalised.current.visibilityM, null);
  assert.equal(normalised.current.visibilityKm, null);
  assert.ok(normalised.daily.every((day) => day.rainfallMm === null));

  const daily = deriveDaily([{ time: "2026-07-13T16:00:00Z", temperatureC: 10, precipitationMm: null }]);
  assert.equal(daily[0].rainfallMm, null);
});

test("freshness labels change at the two-hour and six-hour thresholds", (t) => {
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  Date.now = () => Date.parse("2026-07-13T18:00:00Z");
  assert.equal(getFreshness("2026-07-13T16:01:00Z").state, "fresh");
  assert.equal(getFreshness("2026-07-13T16:00:00Z").state, "stale");
  assert.equal(getFreshness("2026-07-13T12:00:00Z").state, "critical");
  assert.equal(getFreshness(null).state, "unknown");
});

test("news display distinguishes retained dated cards from a live refresh", () => {
  assert.equal(newsDisplayState({ sample: false, preserved: true, items: [] }), "preserved");
  assert.equal(newsDisplayState({ sample: false, unavailable: true, items: [] }), "unavailable");
  assert.equal(newsDisplayState({ sample: false, items: [] }), "live");
});
