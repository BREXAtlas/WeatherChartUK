import {
  DAILY_ATTEMPT_LIMIT,
  LEGACY_DAILY_ATTEMPT_LIMIT,
  REQUIRED_BATCH_SIZE,
} from "./constants.mjs";
import { readJsonState, writeJsonAtomic } from "./fs-json.mjs";

export function utcDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("A valid date is required");
  return date.toISOString().slice(0, 10);
}

function validateCandidate(candidate, label, today) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`${label} is not an object`);
  }
  if (candidate.utcDay != null && candidate.quotaDayUtc != null && candidate.utcDay !== candidate.quotaDayUtc) {
    throw new Error(`${label} has contradictory UTC days`);
  }
  if (candidate.attempts != null && candidate.callsUsed != null && candidate.attempts !== candidate.callsUsed) {
    throw new Error(`${label} has contradictory attempt counts`);
  }
  if (candidate.limit != null && candidate.limitPerUtcDay != null && candidate.limit !== candidate.limitPerUtcDay) {
    throw new Error(`${label} has contradictory limits`);
  }
  const utcDayValue = candidate.utcDay ?? candidate.quotaDayUtc;
  const attemptsValue = candidate.attempts ?? candidate.callsUsed;
  const limitValue = candidate.limit ?? candidate.limitPerUtcDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDayValue ?? "")) {
    throw new Error(`${label} has an invalid UTC day`);
  }
  if (utcDayValue > today) throw new Error(`${label} is dated in the future`);
  if (!Number.isInteger(attemptsValue) || attemptsValue < 0 || attemptsValue > DAILY_ATTEMPT_LIMIT) {
    throw new Error(`${label} has an invalid attempt count`);
  }
  if (![DAILY_ATTEMPT_LIMIT, LEGACY_DAILY_ATTEMPT_LIMIT].includes(limitValue)) {
    throw new Error(`${label} does not enforce the ${DAILY_ATTEMPT_LIMIT}-attempt limit`);
  }
  return {
    ...candidate,
    version: 1,
    utcDay: utcDayValue,
    attempts:
      limitValue === LEGACY_DAILY_ATTEMPT_LIMIT &&
      (candidate.safe === false || /quarantine/i.test(String(candidate.source ?? "")))
        ? DAILY_ATTEMPT_LIMIT
        : attemptsValue,
    limit: DAILY_ATTEMPT_LIMIT,
    unsafe: candidate.safe === false || /quarantine/i.test(String(candidate.source ?? "")),
    ...(limitValue === LEGACY_DAILY_ATTEMPT_LIMIT
      ? { migratedFromLimit: LEGACY_DAILY_ATTEMPT_LIMIT }
      : {}),
  };
}

function publicQuota(
  ledger,
  safe,
  reason = null,
  callsMadeThisRun = 0,
  reservedCallsThisRun = 0,
) {
  return {
    utcDay: ledger.utcDay,
    quotaDayUtc: ledger.utcDay,
    attempts: ledger.attempts,
    callsUsed: ledger.attempts,
    limit: DAILY_ATTEMPT_LIMIT,
    limitPerUtcDay: DAILY_ATTEMPT_LIMIT,
    remaining: Math.max(0, DAILY_ATTEMPT_LIMIT - ledger.attempts),
    callsRemaining: Math.max(0, DAILY_ATTEMPT_LIMIT - ledger.attempts),
    callsMadeThisRun,
    reservedCallsThisRun,
    reservationMode: ledger.reservationMode ?? null,
    lastReservationAt: ledger.lastReservationAt ?? null,
    hardStopEnabled: true,
    safe,
    reason,
    updatedAt: ledger.updatedAt,
    lastAttemptAt: ledger.lastAttemptAt ?? null,
  };
}

export class QuotaLedger {
  constructor({ filePath, ledger, safe = true, reason = null, now = () => new Date() }) {
    this.filePath = filePath;
    this.ledger = ledger;
    this.safe = safe;
    this.reason = reason;
    this.now = now;
    this.callsMadeThisRun = 0;
    this.reservedCallsThisRun = 0;
  }

  get remaining() {
    return Math.max(0, DAILY_ATTEMPT_LIMIT - this.ledger.attempts);
  }

  canStartBatch(size = REQUIRED_BATCH_SIZE) {
    return this.safe && Number.isInteger(size) && size > 0 && this.remaining >= size;
  }

  async reserveBatch(size = REQUIRED_BATCH_SIZE) {
    if (!this.safe) throw Object.assign(new Error("Quota state is unsafe"), { code: "quota-unsafe" });
    if (utcDay(this.now()) !== this.ledger.utcDay) {
      throw Object.assign(new Error("UTC day changed during the update"), { code: "utc-day-changed" });
    }
    if (!Number.isInteger(size) || size < 1) {
      throw Object.assign(new Error("Quota batch size is invalid"), { code: "quota-batch-invalid" });
    }
    if (this.remaining < size) {
      throw Object.assign(new Error("Daily attempt limit cannot fit the full batch"), { code: "quota-exhausted" });
    }
    const reservedAt = this.now().toISOString();
    this.ledger = {
      ...this.ledger,
      attempts: this.ledger.attempts + size,
      updatedAt: reservedAt,
      lastReservationAt: reservedAt,
      reservationMode: "local-atomic-file",
      source: "weather-update-batch-reservation",
    };
    this.reservedCallsThisRun += size;
    // Reserve the whole pending batch in one atomic write before any network I/O.
    await writeJsonAtomic(this.filePath, this.ledger);
    return this.snapshot();
  }

  async applyDurableState(reservation, { safe = true, reason = null } = {}) {
    const now = this.now();
    const day = utcDay(now);
    if (
      reservation?.confirmed !== true ||
      reservation?.durable !== true ||
      reservation.utcDay !== day ||
      reservation.limit !== DAILY_ATTEMPT_LIMIT ||
      !Number.isInteger(reservation.attempts) ||
      reservation.attempts < 0 ||
      reservation.attempts > DAILY_ATTEMPT_LIMIT ||
      !Number.isInteger(reservation.reserved) ||
      reservation.reserved < 0 ||
      (reservation.reserved > 0 && reservation.attemptsAfter !== reservation.attempts)
    ) {
      throw Object.assign(new Error("Durable quota confirmation is invalid"), {
        code: "durable-quota-confirmation-invalid",
      });
    }
    this.ledger = {
      version: 1,
      utcDay: day,
      attempts: reservation.attempts,
      limit: DAILY_ATTEMPT_LIMIT,
      updatedAt: now.toISOString(),
      lastAttemptAt: this.ledger.lastAttemptAt ?? null,
      lastReservationAt: reservation.reservedAt,
      reservationId: reservation.reservationId,
      reservationMode: "github-contents-cas",
      source: "durable-reservation-confirmed",
    };
    this.safe = safe;
    this.reason = reason;
    this.reservedCallsThisRun += reservation.reserved;
    await writeJsonAtomic(this.filePath, this.ledger);
    return this.snapshot();
  }

  async applyDurableReservation(reservation) {
    if (!Number.isInteger(reservation?.reserved) || reservation.reserved < 1) {
      throw Object.assign(new Error("Durable quota reservation is empty"), {
        code: "durable-quota-confirmation-invalid",
      });
    }
    return this.applyDurableState(reservation);
  }

  recordExternalAttempt() {
    if (utcDay(this.now()) !== this.ledger.utcDay) {
      throw Object.assign(new Error("UTC day changed after quota reservation"), {
        code: "utc-day-changed",
      });
    }
    if (this.callsMadeThisRun >= this.reservedCallsThisRun) {
      throw Object.assign(new Error("No pre-reserved quota remains for an external attempt"), {
        code: "quota-reservation-consumed",
      });
    }
    const attemptedAt = this.now().toISOString();
    this.callsMadeThisRun += 1;
    this.ledger.lastAttemptAt = attemptedAt;
    return attemptedAt;
  }

  // Backwards-compatible single-attempt helper for non-batch callers and tests.
  async reserveAttempt() {
    await this.reserveBatch(1);
    this.recordExternalAttempt();
    return this.snapshot();
  }

  snapshot() {
    return publicQuota(
      this.ledger,
      this.safe,
      this.reason,
      this.callsMadeThisRun,
      this.reservedCallsThisRun,
    );
  }
}

function createLedger(day, attempts, now, source) {
  return {
    version: 1,
    utcDay: day,
    attempts,
    limit: DAILY_ATTEMPT_LIMIT,
    updatedAt: now.toISOString(),
    lastAttemptAt: null,
    source,
  };
}

/**
 * Restores a conservative shared ledger from the private cache and public status metadata.
 * Missing, malformed, contradictory or future-dated state is quarantined at the full limit
 * for the current day. That prevents calls today while establishing trustworthy state that
 * can safely roll to zero on the next UTC day.
 */
export async function openQuotaLedger({ ledgerPath, statusPath, now = () => new Date() }) {
  const currentTime = now();
  const today = utcDay(currentTime);
  const [privateState, statusState] = await Promise.all([
    readJsonState(ledgerPath),
    readJsonState(statusPath),
  ]);

  let unsafeReason = null;
  const candidates = [];

  if (privateState.state === "invalid") unsafeReason = "private-ledger-invalid";
  if (privateState.state === "valid") candidates.push({ label: "private ledger", value: privateState.value });

  if (statusState.state === "invalid") unsafeReason ??= "status-metadata-invalid";
  if (statusState.state === "valid" && statusState.value?.quota != null) {
    candidates.push({ label: "deployed status quota", value: statusState.value.quota });
  }

  if (!unsafeReason && candidates.length === 0) unsafeReason = "quota-state-unavailable";

  const validated = [];
  if (!unsafeReason) {
    try {
      for (const candidate of candidates) {
        validated.push(validateCandidate(candidate.value, candidate.label, today));
      }
    } catch {
      unsafeReason = "quota-state-unsafe";
    }
  }

  if (!unsafeReason && validated.some((candidate) => candidate.utcDay === today && candidate.unsafe)) {
    unsafeReason = "quota-state-quarantined";
  }

  if (unsafeReason) {
    const quarantined = createLedger(today, DAILY_ATTEMPT_LIMIT, currentTime, "quarantine");
    await writeJsonAtomic(ledgerPath, quarantined);
    return new QuotaLedger({
      filePath: ledgerPath,
      ledger: quarantined,
      safe: false,
      reason: unsafeReason,
      now,
    });
  }

  const todaysCandidates = validated.filter((candidate) => candidate.utcDay === today);
  let restored;
  if (todaysCandidates.length > 0) {
    // Never let a lower/older copy reduce the number of attempts already recorded.
    const attempts = Math.max(...todaysCandidates.map((candidate) => candidate.attempts));
    const latest = todaysCandidates
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    restored = {
      ...latest,
      version: 1,
      attempts,
      limit: DAILY_ATTEMPT_LIMIT,
      updatedAt: currentTime.toISOString(),
      source: "restored",
    };
  } else {
    restored = createLedger(today, 0, currentTime, "utc-reset");
  }
  await writeJsonAtomic(ledgerPath, restored);
  return new QuotaLedger({ filePath: ledgerPath, ledger: restored, now });
}
