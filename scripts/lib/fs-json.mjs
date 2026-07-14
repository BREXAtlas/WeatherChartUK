import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && arguments.length > 1) return fallbackValue;
    throw error;
  }
}

export async function readJsonState(filePath) {
  try {
    return { state: "valid", value: JSON.parse(await fs.readFile(filePath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", value: null };
    return { state: "invalid", value: null, error };
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporaryPath = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

export async function copyFileAtomic(sourcePath, destinationPath) {
  const contents = await fs.readFile(sourcePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
  await fs.rename(temporaryPath, destinationPath);
}

export function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function asArray(value, propertyName = "items") {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[propertyName])) return value[propertyName];
  return [];
}

export function safeErrorCode(error) {
  if (typeof error?.code === "string" && /^[A-Z0-9_-]{1,40}$/i.test(error.code)) {
    return error.code;
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "request-timeout";
  return "request-failed";
}
