import {
  DAILY_ATTEMPT_LIMIT,
  LEGACY_DAILY_ATTEMPT_LIMIT,
  REQUEST_TIMEOUT_MS,
} from "./constants.mjs";
import { randomUUID } from "node:crypto";
import { safeErrorCode } from "./fs-json.mjs";
import { utcDay } from "./quota-ledger.mjs";

const API_VERSION = "2022-11-28";
const DEFAULT_BRANCH = "weatherchart-quota-state";
const DEFAULT_PATH = ".weatherchart-quota/met-office-global-spot.json";
const MAX_CAS_ATTEMPTS = 3;
const DEFAULT_CONFIRMATION_ATTEMPTS = 4;
const DEFAULT_CONFIRMATION_DELAY_MS = 250;

function durableError(code, message) {
  return Object.assign(new Error(message), { code });
}

function encodePath(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertConfiguration({ apiUrl, repository, token, branch, filePath, reservationId }) {
  if (!/^https:\/\//i.test(apiUrl ?? "")) {
    throw durableError("durable-quota-config-invalid", "GitHub API URL must use HTTPS");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw durableError("durable-quota-config-invalid", "GitHub repository is invalid");
  }
  if (!token) throw durableError("durable-quota-token-missing", "GitHub quota token is missing");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(branch ?? "")) {
    throw durableError("durable-quota-config-invalid", "Quota branch is invalid");
  }
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(filePath ?? "") || filePath.includes("..")) {
    throw durableError("durable-quota-config-invalid", "Quota file path is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(reservationId ?? "")) {
    throw durableError("durable-quota-config-invalid", "Quota reservation id is invalid");
  }
}

function validateDurableRecord(value, today) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw durableError("durable-quota-state-invalid", "Durable quota state is not an object");
  }
  if (
    value.version !== 2 ||
    ![DAILY_ATTEMPT_LIMIT, LEGACY_DAILY_ATTEMPT_LIMIT].includes(value.limit)
  ) {
    throw durableError("durable-quota-state-invalid", "Durable quota state has an invalid schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay ?? "") || value.utcDay > today) {
    throw durableError("durable-quota-state-invalid", "Durable quota state has an invalid UTC day");
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > DAILY_ATTEMPT_LIMIT) {
    throw durableError("durable-quota-state-invalid", "Durable quota state has an invalid count");
  }
  if (!Array.isArray(value.reservations)) {
    throw durableError("durable-quota-state-invalid", "Durable quota reservations are missing");
  }
  if (!Number.isFinite(Date.parse(value.updatedAt ?? ""))) {
    throw durableError("durable-quota-state-invalid", "Durable quota update timestamp is invalid");
  }
  const reservationIds = new Set();
  for (const reservation of value.reservations) {
    if (
      !reservation ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(reservation.id ?? "") ||
      reservationIds.has(reservation.id) ||
      !Number.isInteger(reservation.size) ||
      reservation.size < 1 ||
      reservation.size > DAILY_ATTEMPT_LIMIT ||
      !Number.isInteger(reservation.attemptsBefore) ||
      reservation.attemptsBefore < 0 ||
      !Number.isInteger(reservation.attemptsAfter) ||
      reservation.attemptsAfter > DAILY_ATTEMPT_LIMIT ||
      reservation.attemptsAfter - reservation.attemptsBefore !== reservation.size ||
      !Number.isFinite(Date.parse(reservation.reservedAt ?? ""))
    ) {
      throw durableError("durable-quota-state-invalid", "Durable quota state contains an invalid reservation");
    }
    reservationIds.add(reservation.id);
  }
  if (value.reservations.some(({ attemptsAfter }) => attemptsAfter > value.attempts)) {
    throw durableError("durable-quota-state-invalid", "Durable quota count is behind its reservations");
  }
  return value.limit === LEGACY_DAILY_ATTEMPT_LIMIT
    ? {
        ...value,
        // Raising the ceiling must never turn an old missing-state quarantine
        // into spendable headroom.
        attempts: value.source === "missing-durable-state-quarantine"
          ? DAILY_ATTEMPT_LIMIT
          : value.attempts,
        limit: DAILY_ATTEMPT_LIMIT,
        migratedFromLimit: LEGACY_DAILY_ATTEMPT_LIMIT,
      }
    : value;
}

function reservationResult(record, reservation, sha) {
  return {
    confirmed: true,
    durable: true,
    utcDay: record.utcDay,
    limit: record.limit,
    attempts: record.attempts,
    attemptsBefore: reservation.attemptsBefore,
    attemptsAfter: reservation.attemptsAfter,
    reserved: reservation.size,
    reservationId: reservation.id,
    reservedAt: reservation.reservedAt,
    sha,
  };
}

export class GitHubContentsQuotaStore {
  constructor({
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    repository = process.env.GITHUB_REPOSITORY ?? "",
    token = process.env.WEATHERCHART_QUOTA_TOKEN ?? "",
    branch = process.env.WEATHERCHART_QUOTA_BRANCH ?? DEFAULT_BRANCH,
    filePath = process.env.WEATHERCHART_QUOTA_PATH ?? DEFAULT_PATH,
    reservationId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}:${randomUUID()}`,
    fetchImpl = fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    now = () => new Date(),
    confirmationAttempts = DEFAULT_CONFIRMATION_ATTEMPTS,
    confirmationDelayMs = DEFAULT_CONFIRMATION_DELAY_MS,
  } = {}) {
    this.apiUrl = String(apiUrl).replace(/\/$/, "");
    this.repository = repository;
    this.token = token;
    this.branch = branch;
    this.filePath = filePath;
    this.reservationId = reservationId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.confirmationAttempts = Math.max(1, Math.min(10, Number(confirmationAttempts) || 1));
    this.confirmationDelayMs = Math.max(0, Math.min(2_000, Number(confirmationDelayMs) || 0));
  }

  async request(path, { method = "GET", body } = {}) {
    assertConfiguration(this);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": API_VERSION,
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw durableError(
        safeErrorCode(error) === "request-timeout" ? "durable-quota-timeout" : "durable-quota-network",
        "GitHub durable quota request failed",
      );
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Status codes, not response text, are used below. This avoids reflecting API output.
    }
    return { ok: Boolean(response.ok), status: Number(response.status), data };
  }

  refPath(branch = this.branch) {
    return `/repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`;
  }

  contentsPath() {
    return `/repos/${this.repository}/contents/${encodePath(this.filePath)}`;
  }

  async ensureBranch() {
    const existing = await this.request(this.refPath());
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw durableError("durable-quota-branch-unavailable", "Durable quota branch could not be read");
    }

    const repository = await this.request(`/repos/${this.repository}`);
    const defaultBranch = repository.data?.default_branch;
    if (!repository.ok || !/^[A-Za-z0-9._/-]{1,200}$/.test(defaultBranch ?? "")) {
      throw durableError("durable-quota-branch-unavailable", "Repository default branch could not be read");
    }
    const base = await this.request(this.refPath(defaultBranch));
    const sha = base.data?.object?.sha;
    if (!base.ok || !/^[a-f0-9]{40}$/i.test(sha ?? "")) {
      throw durableError("durable-quota-branch-unavailable", "Default branch head could not be read");
    }
    const created = await this.request(`/repos/${this.repository}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${this.branch}`, sha },
    });
    if (created.ok) return;
    if (created.status === 422) {
      const raced = await this.request(this.refPath());
      if (raced.ok) return;
    }
    throw durableError("durable-quota-branch-unavailable", "Durable quota branch could not be created");
  }

  async readState(day) {
    const response = await this.request(`${this.contentsPath()}?ref=${encodeURIComponent(this.branch)}`);
    if (response.status === 404) return { state: "missing", record: null, sha: null };
    if (!response.ok || response.data?.type !== "file" || !/^[a-f0-9]{40}$/i.test(response.data?.sha ?? "")) {
      throw durableError("durable-quota-read-unconfirmed", "Durable quota file could not be read");
    }
    try {
      const source = Buffer.from(String(response.data.content ?? "").replace(/\s/g, ""), "base64").toString("utf8");
      return {
        state: "valid",
        record: validateDurableRecord(JSON.parse(source), day),
        sha: response.data.sha,
      };
    } catch (error) {
      if (error?.code === "durable-quota-state-invalid") throw error;
      throw durableError("durable-quota-state-invalid", "Durable quota file is malformed");
    }
  }

  async writeState(record, sha) {
    const body = {
      message: record.source === "operator-confirmed-bootstrap"
        ? `Initialize Met Office quota for ${record.utcDay}`
        : `Reserve Met Office quota for ${record.utcDay}`,
      content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8").toString("base64"),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    return this.request(this.contentsPath(), { method: "PUT", body });
  }

  async waitForConfirmation(day, predicate, { code, message }) {
    for (let attempt = 0; attempt < this.confirmationAttempts; attempt += 1) {
      try {
        const confirmed = await this.readState(day);
        if (predicate(confirmed)) return confirmed;
      } catch (error) {
        // A malformed durable record is not an eventual-consistency condition.
        if (error?.code === "durable-quota-state-invalid") throw error;
      }
      if (attempt + 1 < this.confirmationAttempts && this.confirmationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.confirmationDelayMs));
      }
    }
    throw durableError(code, message);
  }

  async confirmReservation(day, expected) {
    const confirmed = await this.waitForConfirmation(
      day,
      (value) => {
        const reservation = value.record?.reservations?.find(({ id }) => id === this.reservationId);
        return value.state === "valid"
          && value.record.utcDay === day
          && reservation?.size === expected.size
          && reservation.attemptsBefore === expected.attemptsBefore
          && reservation.attemptsAfter === expected.attemptsAfter
          && value.record.attempts >= expected.attemptsAfter;
      },
      {
        code: "durable-quota-write-unconfirmed",
        message: "Durable quota reservation could not be confirmed",
      },
    );
    const reservation = confirmed.record.reservations.find(({ id }) => id === this.reservationId);
    return reservationResult(confirmed.record, reservation, confirmed.sha);
  }

  async quarantineMissingState(day) {
    const quarantineTime = this.now();
    if (utcDay(quarantineTime) !== day) {
      throw durableError("utc-day-changed", "UTC day changed before durable quarantine");
    }
    const quarantinedAt = quarantineTime.toISOString();
    const record = {
      version: 2,
      utcDay: day,
      attempts: DAILY_ATTEMPT_LIMIT,
      limit: DAILY_ATTEMPT_LIMIT,
      updatedAt: quarantinedAt,
      source: "missing-durable-state-quarantine",
      reservations: [],
    };
    const written = await this.writeState(record, null);
    if (!written.ok) return written;
    await this.waitForConfirmation(
      day,
      (confirmed) => confirmed.state === "valid"
        && confirmed.record.utcDay === day
        && confirmed.record.attempts === DAILY_ATTEMPT_LIMIT
        && confirmed.record.source === "missing-durable-state-quarantine",
      {
        code: "durable-quota-write-unconfirmed",
        message: "Durable quota quarantine could not be confirmed",
      },
    );
    const error = durableError(
      "durable-quota-bootstrap-quarantined",
      "Missing durable quota state was quarantined for the current UTC day",
    );
    error.durableState = {
      confirmed: true,
      durable: true,
      utcDay: day,
      limit: DAILY_ATTEMPT_LIMIT,
      attempts: DAILY_ATTEMPT_LIMIT,
      reserved: 0,
      reservationId: null,
      reservedAt: quarantinedAt,
    };
    throw error;
  }

  async bootstrapCurrentDay({ day, attempts, actor = process.env.GITHUB_ACTOR ?? "unknown" } = {}) {
    assertConfiguration(this);
    const operationDay = utcDay(this.now());
    if (day !== operationDay) {
      throw durableError(
        "durable-quota-bootstrap-day-mismatch",
        "The confirmed bootstrap day must equal the current UTC day",
      );
    }
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > DAILY_ATTEMPT_LIMIT) {
      throw durableError(
        "durable-quota-bootstrap-count-invalid",
        "The confirmed bootstrap count is invalid",
      );
    }
    await this.ensureBranch();
    const current = await this.readState(operationDay);
    const replaceableQuarantine =
      current.state === "valid" &&
      current.record.utcDay === operationDay &&
      current.record.source === "missing-durable-state-quarantine" &&
      current.record.reservations.length === 0;
    if (current.state !== "missing" && !replaceableQuarantine) {
      throw durableError(
        "durable-quota-bootstrap-refused",
        "Bootstrap cannot replace an active or previously bootstrapped quota ledger",
      );
    }

    const initialisedAt = this.now().toISOString();
    if (utcDay(initialisedAt) !== operationDay) {
      throw durableError("utc-day-changed", "UTC day changed before quota bootstrap");
    }
    const record = {
      version: 2,
      utcDay: operationDay,
      attempts,
      limit: DAILY_ATTEMPT_LIMIT,
      updatedAt: initialisedAt,
      source: "operator-confirmed-bootstrap",
      reservations: [],
      bootstrapAudit: {
        method: "workflow-dispatch-operator-confirmed",
        actor: String(actor).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100) || "unknown",
        workflowRunId: String(process.env.GITHUB_RUN_ID ?? "local").slice(0, 100),
        confirmedAttempts: attempts,
        confirmedUtcDay: operationDay,
        initialisedAt,
        replacedQuarantine: replaceableQuarantine,
      },
    };
    const written = await this.writeState(record, current.sha);
    if (!written.ok) {
      throw durableError(
        "durable-quota-bootstrap-write-failed",
        "The operator-confirmed quota bootstrap could not be written",
      );
    }
    await this.waitForConfirmation(
      operationDay,
      (confirmed) => confirmed.state === "valid"
        && confirmed.record.utcDay === operationDay
        && confirmed.record.attempts === attempts
        && confirmed.record.limit === DAILY_ATTEMPT_LIMIT
        && confirmed.record.source === "operator-confirmed-bootstrap"
        && confirmed.record.bootstrapAudit?.confirmedAttempts === attempts,
      {
        code: "durable-quota-bootstrap-write-unconfirmed",
        message: "The operator-confirmed quota bootstrap could not be read back",
      },
    );
    return { day: operationDay, attempts, limit: DAILY_ATTEMPT_LIMIT, confirmed: true };
  }

  async reserveBatch({ size, minimumAttempts = null } = {}) {
    assertConfiguration(this);
    if (!Number.isInteger(size) || size < 1 || size > DAILY_ATTEMPT_LIMIT) {
      throw durableError("durable-quota-reservation-invalid", "Quota reservation size is invalid");
    }
    if (minimumAttempts != null && (
      !Number.isInteger(minimumAttempts) ||
      minimumAttempts < 0 ||
      minimumAttempts > DAILY_ATTEMPT_LIMIT
    )) {
      throw durableError("durable-quota-reservation-invalid", "Quota baseline is invalid");
    }

    const operationDay = utcDay(this.now());
    await this.ensureBranch();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      if (utcDay(this.now()) !== operationDay) {
        throw durableError("utc-day-changed", "UTC day changed during durable quota reservation");
      }
      const current = await this.readState(operationDay);
      if (current.state === "missing") {
        const quarantined = await this.quarantineMissingState(operationDay);
        if ([409, 422].includes(quarantined.status)) continue;
        throw durableError("durable-quota-write-failed", "Missing durable quota state could not be quarantined");
      }

      const currentDayRecord = current.record?.utcDay === operationDay ? current.record : null;
      const existingReservation = currentDayRecord?.reservations.find(({ id }) => id === this.reservationId);
      if (existingReservation) {
        if (existingReservation.size !== size) {
          throw durableError("durable-quota-reservation-conflict", "Reservation id was reused with another size");
        }
        if (minimumAttempts != null && currentDayRecord.attempts < minimumAttempts) {
          throw durableError(
            "durable-quota-state-behind",
            "Durable quota state is behind a trusted local baseline",
          );
        }
        return this.confirmReservation(operationDay, existingReservation);
      }

      const durableAttempts = currentDayRecord?.attempts ?? 0;
      const baseline = Math.max(durableAttempts, minimumAttempts ?? 0);
      if (baseline + size > DAILY_ATTEMPT_LIMIT) {
        throw durableError("durable-quota-exhausted", "Daily durable quota cannot fit the full batch");
      }

      const reservationTime = this.now();
      if (utcDay(reservationTime) !== operationDay) {
        throw durableError("utc-day-changed", "UTC day changed before durable quota write");
      }
      const reservedAt = reservationTime.toISOString();
      const reservation = {
        id: this.reservationId,
        size,
        attemptsBefore: baseline,
        attemptsAfter: baseline + size,
        reservedAt,
      };
      const next = {
        version: 2,
        utcDay: operationDay,
        attempts: baseline + size,
        limit: DAILY_ATTEMPT_LIMIT,
        updatedAt: reservedAt,
        source: "github-contents-durable-reservation",
        reservations: [...(currentDayRecord?.reservations ?? []), reservation].slice(-40),
      };
      const written = await this.writeState(next, current.sha);
      if (written.ok) return this.confirmReservation(operationDay, reservation);
      if (![409, 422].includes(written.status)) {
        throw durableError("durable-quota-write-failed", "Durable quota reservation could not be written");
      }
      // A competing writer changed the file. Re-read it and retry the compare-and-swap.
    }
    throw durableError("durable-quota-write-conflict", "Durable quota reservation conflicted repeatedly");
  }
}

export function createGitHubQuotaStoreFromEnvironment(options = {}) {
  const token = options.token ?? process.env.WEATHERCHART_QUOTA_TOKEN ?? "";
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !repository) return null;
  return new GitHubContentsQuotaStore({ ...options, token, repository });
}
