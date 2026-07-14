import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { GitHubContentsQuotaStore } from "../scripts/lib/durable-quota-store.mjs";
import { readJson, writeJsonAtomic } from "../scripts/lib/fs-json.mjs";
import { runWeatherUpdate } from "../scripts/update-weather-data.mjs";
import { removeRoot, seedPrivateLedger, temporaryRoot } from "./helpers.mjs";

const fixtureUrl = new URL("./fixtures/metoffice-hourly.json", import.meta.url);
const fixture = JSON.parse(await fs.readFile(fixtureUrl, "utf8"));
const workflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);

function apiResponse(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

function createFakeGitHub({
  branchExists = true,
  conflictOnce = false,
  hideConfirmationReads = 0,
} = {}) {
  const state = {
    branchExists,
    record: null,
    sha: null,
    writes: 0,
    requests: [],
    conflictOnce,
    hideConfirmationReads,
    afterWrite: false,
  };
  let shaCounter = 1;
  const nextSha = () => (shaCounter++).toString(16).padStart(40, "0");

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    state.requests.push({ url: String(url), method, headers: options.headers, body });
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.doesNotMatch(String(url), /test-token/);

    if (url.pathname === "/repos/example/weather/git/ref/heads/weatherchart-quota-state") {
      return state.branchExists
        ? apiResponse(200, { object: { sha: "a".repeat(40) } })
        : apiResponse(404);
    }
    if (url.pathname === "/repos/example/weather") {
      return apiResponse(200, { default_branch: "main" });
    }
    if (url.pathname === "/repos/example/weather/git/ref/heads/main") {
      return apiResponse(200, { object: { sha: "b".repeat(40) } });
    }
    if (url.pathname === "/repos/example/weather/git/refs" && method === "POST") {
      state.branchExists = true;
      return apiResponse(201, { object: { sha: body.sha } });
    }
    if (url.pathname === "/repos/example/weather/contents/.weatherchart-quota/met-office-global-spot.json") {
      if (method === "GET") {
        if (state.afterWrite && state.hideConfirmationReads > 0) {
          state.hideConfirmationReads -= 1;
          return apiResponse(404);
        }
        if (!state.record) return apiResponse(404);
        return apiResponse(200, {
          type: "file",
          sha: state.sha,
          content: Buffer.from(`${JSON.stringify(state.record)}\n`).toString("base64"),
        });
      }
      if (method === "PUT") {
        if (state.conflictOnce) {
          state.conflictOnce = false;
          const incoming = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
          const reservedAt = incoming.updatedAt;
          state.record = {
            version: 2,
            utcDay: incoming.utcDay,
            attempts: 12,
            limit: 350,
            updatedAt: reservedAt,
            source: "github-contents-durable-reservation",
            reservations: [{
              id: "competing-run:1",
              size: 12,
              attemptsBefore: 0,
              attemptsAfter: 12,
              reservedAt,
            }],
          };
          state.sha = nextSha();
          return apiResponse(409);
        }
        if (state.record && body.sha !== state.sha) return apiResponse(409);
        if (!state.record && body.sha != null) return apiResponse(409);
        state.record = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
        state.sha = nextSha();
        state.writes += 1;
        state.afterWrite = true;
        return apiResponse(state.writes === 1 ? 201 : 200, {
          content: { sha: state.sha },
          commit: { sha: nextSha() },
        });
      }
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${url.pathname}`);
  };

  return { state, fetchImpl };
}

function quotaStore(fake, now, reservationId, options = {}) {
  return new GitHubContentsQuotaStore({
    apiUrl: "https://api.github.test",
    repository: "example/weather",
    token: "test-token",
    reservationId,
    fetchImpl: fake.fetchImpl,
    now: () => now,
    ...options,
  });
}

function seedDurableRecord(fake, { day = "2026-07-13", attempts = 0 } = {}) {
  fake.state.record = {
    version: 2,
    utcDay: day,
    attempts,
    limit: 350,
    updatedAt: `${day}T00:00:00.000Z`,
    source: "github-contents-durable-reservation",
    reservations: [],
  };
  fake.state.sha = "c".repeat(40);
}

test("GitHub Contents store creates its branch and quarantines a missing file for the UTC day", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub({ branchExists: false });
  const store = quotaStore(fake, now, "run-101:1");
  await assert.rejects(
    store.reserveBatch({ size: 12, minimumAttempts: 24 }),
    { code: "durable-quota-bootstrap-quarantined" },
  );

  assert.equal(fake.state.record.attempts, 350);
  assert.equal(fake.state.record.limit, 350);
  assert.equal(fake.state.record.source, "missing-durable-state-quarantine");
  assert.deepEqual(fake.state.record.reservations, []);
  assert.equal(fake.state.writes, 1);
  assert.equal(fake.state.requests.some(({ method, url }) => method === "POST" && url.endsWith("/git/refs")), true);
});

test("an explicit operator bootstrap replaces only a missing-state quarantine and is one-time", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  const store = quotaStore(fake, now, "run-bootstrap:1");
  await assert.rejects(
    store.reserveBatch({ size: 12, minimumAttempts: 0 }),
    { code: "durable-quota-bootstrap-quarantined" },
  );
  assert.equal(fake.state.record.source, "missing-durable-state-quarantine");
  assert.equal(fake.state.record.attempts, 350);

  const bootstrapped = await store.bootstrapCurrentDay({
    day: "2026-07-13",
    attempts: 0,
    actor: "weather-operator",
  });
  assert.deepEqual(bootstrapped, {
    day: "2026-07-13",
    attempts: 0,
    limit: 350,
    confirmed: true,
  });
  assert.equal(fake.state.record.source, "operator-confirmed-bootstrap");
  assert.equal(fake.state.record.bootstrapAudit.replacedQuarantine, true);
  assert.equal(fake.state.record.bootstrapAudit.actor, "weather-operator");

  await assert.rejects(
    store.bootstrapCurrentDay({ day: "2026-07-13", attempts: 0 }),
    { code: "durable-quota-bootstrap-refused" },
  );
  const reservation = await store.reserveBatch({ size: 12, minimumAttempts: 0 });
  assert.equal(reservation.attempts, 12);
});

test("operator bootstrap refuses a day other than the current UTC day", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  await assert.rejects(
    quotaStore(fake, now, "run-bootstrap:2").bootstrapCurrentDay({
      day: "2026-07-12",
      attempts: 0,
    }),
    { code: "durable-quota-bootstrap-day-mismatch" },
  );
  assert.equal(fake.state.requests.length, 0);
});

test("a valid previous-day durable record resets before confirming a full batch", async () => {
  const now = new Date("2026-07-14T00:05:00Z");
  const fake = createFakeGitHub();
  seedDurableRecord(fake, { day: "2026-07-13", attempts: 350 });
  const result = await quotaStore(fake, now, "run-101b:1").reserveBatch({
    size: 12,
    minimumAttempts: 0,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.attemptsBefore, 0);
  assert.equal(result.attemptsAfter, 12);
  assert.equal(fake.state.record.utcDay, "2026-07-14");
  assert.equal(fake.state.record.attempts, 12);
});

test("a legacy 300-limit durable record migrates without reducing its attempt count", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  seedDurableRecord(fake, { attempts: 288 });
  fake.state.record.limit = 300;
  const result = await quotaStore(fake, now, "run-legacy:1").reserveBatch({
    size: 12,
    minimumAttempts: 288,
  });
  assert.equal(result.attemptsBefore, 288);
  assert.equal(result.attemptsAfter, 300);
  assert.equal(fake.state.record.limit, 350);
  assert.equal(fake.state.record.attempts, 300);
});

test("a legacy missing-state quarantine remains fully quarantined after the limit increase", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  seedDurableRecord(fake, { attempts: 300 });
  fake.state.record.limit = 300;
  fake.state.record.source = "missing-durable-state-quarantine";
  await assert.rejects(
    quotaStore(fake, now, "run-legacy-quarantine:1").reserveBatch({
      size: 12,
      minimumAttempts: 0,
    }),
    { code: "durable-quota-exhausted" },
  );
  assert.equal(fake.state.writes, 0);
  const bootstrapped = await quotaStore(fake, now, "run-legacy-quarantine:2").bootstrapCurrentDay({
    day: "2026-07-13",
    attempts: 0,
  });
  assert.equal(bootstrapped.attempts, 0);
  assert.equal(fake.state.record.limit, 350);
  assert.equal(fake.state.record.source, "operator-confirmed-bootstrap");
});

test("a repeated reservation id is idempotent and cannot double-count", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  seedDurableRecord(fake);
  const store = quotaStore(fake, now, "run-102:1");
  const first = await store.reserveBatch({ size: 12, minimumAttempts: 0 });
  const second = await store.reserveBatch({ size: 12, minimumAttempts: 0 });

  assert.equal(first.attempts, 12);
  assert.equal(second.attempts, 12);
  assert.equal(fake.state.record.attempts, 12);
  assert.equal(fake.state.record.reservations.length, 1);
  assert.equal(fake.state.writes, 1);
});

test("a compare-and-swap conflict re-reads the higher count before reserving", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub({ conflictOnce: true });
  const result = await quotaStore(fake, now, "run-103:1").reserveBatch({
    size: 12,
    minimumAttempts: 0,
  });

  assert.equal(result.attemptsBefore, 12);
  assert.equal(result.attemptsAfter, 24);
  assert.equal(fake.state.record.attempts, 24);
  assert.deepEqual(fake.state.record.reservations.map(({ id }) => id), ["competing-run:1", "run-103:1"]);
});

test("a single delayed readback is retried before a reservation is returned", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub({ hideConfirmationReads: 1 });
  seedDurableRecord(fake);
  const result = await quotaStore(fake, now, "run-103b:1", {
    confirmationDelayMs: 0,
  }).reserveBatch({ size: 12, minimumAttempts: 0 });
  assert.equal(result.confirmed, true);
  assert.equal(result.attempts, 12);
  assert.equal(fake.state.writes, 1);
});

test("a write that cannot be read back is never returned as a usable reservation", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub({ hideConfirmationReads: 10 });
  seedDurableRecord(fake);
  await assert.rejects(
    quotaStore(fake, now, "run-103c:1", {
      confirmationAttempts: 3,
      confirmationDelayMs: 0,
    }).reserveBatch({ size: 12, minimumAttempts: 0 }),
    { code: "durable-quota-write-unconfirmed" },
  );
  assert.equal(fake.state.record.attempts, 12);
  assert.equal(fake.state.writes, 1);
});

test("a missing durable file fails closed even when a local baseline is supplied", async () => {
  const now = new Date("2026-07-13T18:00:00Z");
  const fake = createFakeGitHub();
  await assert.rejects(
    quotaStore(fake, now, "run-104:1").reserveBatch({ size: 12, minimumAttempts: 0 }),
    { code: "durable-quota-bootstrap-quarantined" },
  );
  assert.equal(fake.state.writes, 1);
  assert.equal(fake.state.record.attempts, 350);
});

test("pipeline publishes the confirmed 350-call quarantine and makes no Met Office call", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  const fake = createFakeGitHub();
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: quotaStore(fake, now, "run-105:1"),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => fixture };
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "durable-quota-bootstrap-quarantined");
  assert.equal(calls, 0);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 350);
  const deployedStatus = await readJson(paths.statusPath);
  assert.equal(deployedStatus.quota.attempts, 350);
  assert.equal(deployedStatus.quota.safe, false);
});

test("durable state survives a failed request and complete local cache loss", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  const fake = createFakeGitHub();
  seedDurableRecord(fake);
  let upstreamCalls = 0;

  const first = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: quotaStore(fake, now, "run-201:1"),
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error("simulated runner crash boundary");
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(first.outcome, "request-failed");
  assert.equal(fake.state.record.attempts, 12);

  await Promise.all([
    fs.rm(paths.quotaLedgerPath, { force: true }),
    fs.rm(paths.statusPath, { force: true }),
  ]);
  const second = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: quotaStore(fake, now, "run-202:1"),
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error("offline after cache loss");
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });

  assert.equal(second.outcome, "request-failed");
  assert.equal(upstreamCalls, 2);
  assert.equal(fake.state.record.attempts, 24);
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 24);
  assert.equal((await readJson(paths.statusPath)).quota.reservedCallsThisRun, 12);
});

test("durable exhaustion stops before any upstream request", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(new Date("2026-07-13T15:00:00Z"));
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 0);
  const status = await readJson(paths.statusPath);
  status.quota = await readJson(paths.quotaLedgerPath);
  await writeJsonAtomic(paths.statusPath, status);
  const fake = createFakeGitHub();
  seedDurableRecord(fake, { attempts: 349 });
  let calls = 0;
  const result = await runWeatherUpdate({
    rootDir,
    now: () => now,
    apiKey: "unit-test-placeholder",
    requireDurableQuota: true,
    durableQuotaStore: quotaStore(fake, now, "run-203:1"),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => fixture };
    },
    fallbackFetchImpl: async () => { throw new Error("fallback offline"); },
  });
  assert.equal(result.outcome, "durable-quota-exhausted");
  assert.equal(calls, 0);
  assert.equal(fake.state.record.attempts, 349);
});

test("standalone deployment reserves durable quota before refreshing and isolates its secret from deploy", async () => {
  const workflow = await fs.readFile(workflowUrl, "utf8");
  const bootstrapIndex = workflow.indexOf("Bootstrap durable quota from an operator-confirmed count");
  const refreshIndex = workflow.indexOf("Refresh hourly forecast data");
  const snapshotIndex = workflow.indexOf("Recheck and snapshot the verified deployment candidate");
  const deployIndex = workflow.indexOf("- name: Deploy to GitHub Pages");
  const persistIndex = workflow.indexOf("Persist the successfully deployed private snapshot");
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  deploy:"));
  const deploy = workflow.slice(workflow.indexOf("  deploy:"));
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /name:\s*github-pages/);
  assert.match(workflow, /https:\/\/brexatlas\.github\.io\/WeatherChartUK\/data\//);
  assert.match(workflow, /cron:\s*['"]17 \* \* \* \*['"]/);
  assert.match(prepare, /WEATHERCHART_REQUIRE_DURABLE_QUOTA:\s*['"]true['"]/);
  assert.match(prepare, /WEATHERCHART_QUOTA_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.equal((prepare.match(/secrets\.MET_OFFICE_API_KEY/g) ?? []).length, 1);
  assert.doesNotMatch(deploy, /MET_OFFICE_API_KEY|WEATHERCHART_QUOTA_TOKEN/);
  assert.ok(bootstrapIndex > 0 && refreshIndex > bootstrapIndex);
  assert.ok(snapshotIndex > refreshIndex && deployIndex > snapshotIndex);
  assert.ok(persistIndex > deployIndex);
  assert.doesNotMatch(workflow.slice(0, deployIndex), /actions\/cache\/save/);
  assert.match(workflow, /--exclude='data\/sample\/'/);
});
