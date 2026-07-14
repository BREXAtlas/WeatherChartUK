import { DEFAULT_LOCATIONS, REQUIRED_BATCH_SIZE } from "./constants.mjs";
import { readJson } from "./fs-json.mjs";

const EXPECTED_IDS = new Set(DEFAULT_LOCATIONS.map(({ id }) => id));

function normaliseLocation(raw) {
  const id = String(raw?.id ?? "").trim().toLowerCase();
  const name = String(raw?.name ?? "").trim();
  const region = String(raw?.region ?? raw?.country ?? "United Kingdom").trim();
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  if (!EXPECTED_IDS.has(id)) throw new Error(`Unexpected configured location id: ${id || "(empty)"}`);
  if (!name) throw new Error(`Configured location ${id} has no name`);
  if (!Number.isFinite(latitude) || latitude < -85 || latitude > 85) {
    throw new Error(`Configured location ${id} has an invalid latitude`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`Configured location ${id} has an invalid longitude`);
  }
  return { id, name, region, latitude, longitude };
}

export function validateLocations(locations) {
  if (!Array.isArray(locations) || locations.length !== REQUIRED_BATCH_SIZE) {
    throw new Error(`Exactly ${REQUIRED_BATCH_SIZE} configured locations are required`);
  }
  const normalised = locations.map(normaliseLocation);
  if (new Set(normalised.map(({ id }) => id)).size !== REQUIRED_BATCH_SIZE) {
    throw new Error("Configured location ids must be unique");
  }
  for (const id of EXPECTED_IDS) {
    if (!normalised.some((location) => location.id === id)) {
      throw new Error(`Configured locations are missing ${id}`);
    }
  }
  return normalised;
}

export async function loadLocations(locationsPath) {
  const configured = await readJson(locationsPath, null);
  if (!configured) return validateLocations(DEFAULT_LOCATIONS);
  return validateLocations(Array.isArray(configured) ? configured : configured.locations);
}
