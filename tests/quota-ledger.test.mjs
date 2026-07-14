import assert from "node:assert/strict";
import test from "node:test";
import { openQuotaLedger } from "../scripts/lib/quota-ledger.mjs";
import { readJson, writeJsonAtomic } from "../scripts/lib/fs-json.mjs";
import { removeRoot, seedPrivateLedger, temporaryRoot } from "./helpers.mjs";

test("missing quota state quarantines the current UTC day without allowing calls", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await import("node:fs/promises").then(({ default: fs }) => Promise.all([
    fs.rm(paths.quotaLedgerPath, { force: true }),
    fs.rm(paths.statusPath, { force: true }),
  ]));

  const quota = await openQuotaLedger({ ledgerPath: paths.quotaLedgerPath, statusPath: paths.statusPath, now: () => now });
  assert.equal(quota.safe, false);
  assert.equal(quota.canStartBatch(), false);
  assert.equal(quota.snapshot().attempts, 350);
  assert.equal((await readJson(paths.quotaLedgerPath)).source, "quarantine");
});

test("a valid previous-day ledger resets safely at midnight UTC", async (t) => {
  const now = new Date("2026-07-14T00:05:00Z");
  const yesterday = new Date("2026-07-13T23:55:00Z");
  const { rootDir, paths } = await temporaryRoot(yesterday);
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, yesterday, 288);

  const quota = await openQuotaLedger({ ledgerPath: paths.quotaLedgerPath, statusPath: paths.statusPath, now: () => now });
  assert.equal(quota.safe, true);
  assert.equal(quota.snapshot().utcDay, "2026-07-14");
  assert.equal(quota.snapshot().attempts, 0);
  assert.equal(quota.remaining, 350);
});

test("the highest trustworthy current-day count wins and reservations persist first", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 41);
  const status = await readJson(paths.statusPath);
  status.quota = { ...(await readJson(paths.quotaLedgerPath)), attempts: 37 };
  await writeJsonAtomic(paths.statusPath, status);

  const quota = await openQuotaLedger({ ledgerPath: paths.quotaLedgerPath, statusPath: paths.statusPath, now: () => now });
  assert.equal(quota.snapshot().attempts, 41);
  await quota.reserveAttempt();
  assert.equal((await readJson(paths.quotaLedgerPath)).attempts, 42);
  assert.equal(quota.snapshot().callsMadeThisRun, 1);
});

test("a legacy 300-limit status migrates to the 350 ceiling without lowering its count", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await import("node:fs/promises").then(({ default: fs }) => fs.rm(paths.quotaLedgerPath, { force: true }));
  const status = await readJson(paths.statusPath);
  status.quota = {
    quotaDayUtc: "2026-07-13",
    limitPerUtcDay: 300,
    callsUsed: 0,
    callsRemaining: 300,
    callsMadeThisRun: 0,
    hardStopEnabled: true,
  };
  await writeJsonAtomic(paths.statusPath, status);

  const quota = await openQuotaLedger({ ledgerPath: paths.quotaLedgerPath, statusPath: paths.statusPath, now: () => now });
  assert.equal(quota.safe, true);
  assert.equal(quota.snapshot().limit, 350);
  assert.equal(quota.snapshot().attempts, 0);
  assert.equal(quota.canStartBatch(12), true);
});

test("a current-day unsafe legacy status remains quarantined at the new ceiling", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await import("node:fs/promises").then(({ default: fs }) => fs.rm(paths.quotaLedgerPath, { force: true }));
  const status = await readJson(paths.statusPath);
  status.quota = {
    quotaDayUtc: "2026-07-13",
    limitPerUtcDay: 300,
    callsUsed: 300,
    safe: false,
    reason: "durable-quota-bootstrap-quarantined",
  };
  await writeJsonAtomic(paths.statusPath, status);
  const quota = await openQuotaLedger({
    ledgerPath: paths.quotaLedgerPath,
    statusPath: paths.statusPath,
    now: () => now,
  });
  assert.equal(quota.safe, false);
  assert.equal(quota.snapshot().attempts, 350);
  assert.equal(quota.canStartBatch(12), false);
});

test("fewer than twelve remaining calls cannot start a location batch", async (t) => {
  const now = new Date("2026-07-13T18:00:00Z");
  const { rootDir, paths } = await temporaryRoot(now);
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, now, 339);

  const quota = await openQuotaLedger({ ledgerPath: paths.quotaLedgerPath, statusPath: paths.statusPath, now: () => now });
  assert.equal(quota.remaining, 11);
  assert.equal(quota.canStartBatch(12), false);
});

test("a reserved batch cannot make another request after the UTC day changes", async (t) => {
  let current = new Date("2026-07-13T23:50:00Z");
  const { rootDir, paths } = await temporaryRoot(current);
  t.after(() => removeRoot(rootDir));
  await seedPrivateLedger(paths, current, 0);
  const quota = await openQuotaLedger({
    ledgerPath: paths.quotaLedgerPath,
    statusPath: paths.statusPath,
    now: () => current,
  });
  await quota.reserveBatch(12);
  current = new Date("2026-07-14T00:00:00Z");
  assert.throws(() => quota.recordExternalAttempt(), { code: "utc-day-changed" });
});
