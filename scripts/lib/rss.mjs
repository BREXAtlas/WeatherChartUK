import crypto from "node:crypto";

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["quot", '"'],
  ["lt", "<"],
  ["gt", ">"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["mdash", "—"],
]);

export function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&#(x?[0-9a-f]+);/gi, (_, code) => {
      const number = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : "";
    })
    .replace(/&([a-z]+);/gi, (_, name) => NAMED_ENTITIES.get(name.toLowerCase()) ?? "");
}

export function plainText(value = "", maxLength = 800) {
  const text = decodeXml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return match[1];
  }
  return "";
}

function linkValue(block) {
  const direct = tagValue(block, ["link"]);
  if (plainText(direct)) return plainText(direct, 2_048);
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return atom ? decodeXml(atom[1]).trim() : "";
}

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4],
  ["may", 5], ["jun", 6], ["jul", 7], ["aug", 8],
  ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

const UK_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function dateParts(value) {
  return Object.fromEntries(
    UK_DATE_TIME.formatToParts(value)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]),
  );
}

function ukLocalInstant({ year, month, day, hour, minute }) {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  const calendarCheck = new Date(wallClock);
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day ||
    calendarCheck.getUTCHours() !== hour ||
    calendarCheck.getUTCMinutes() !== minute
  ) return null;

  // Convert a Europe/London wall-clock time without assuming GMT during BST.
  let instant = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = dateParts(new Date(instant));
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const next = wallClock - (shownAsUtc - instant);
    if (next === instant) break;
    instant = next;
  }
  const confirmed = dateParts(new Date(instant));
  if (
    confirmed.year !== year || confirmed.month !== month || confirmed.day !== day ||
    confirmed.hour !== hour || confirmed.minute !== minute
  ) return null;
  return instant;
}

function warningAnchor(url, parsedPublishedDate) {
  const linkedDate = String(url).match(/[?&#]date=(\d{4})-(\d{2})-(\d{2})/i);
  if (linkedDate) {
    const value = Date.UTC(Number(linkedDate[1]), Number(linkedDate[2]) - 1, Number(linkedDate[3]), 12);
    const date = new Date(value);
    if (
      date.getUTCFullYear() === Number(linkedDate[1]) &&
      date.getUTCMonth() === Number(linkedDate[2]) - 1 &&
      date.getUTCDate() === Number(linkedDate[3])
    ) return value;
  }
  return Number.isFinite(parsedPublishedDate) ? parsedPublishedDate : null;
}

function humanWarningDetails(description, url, parsedPublishedDate) {
  const validity = String(description).match(
    /\bvalid\s+from\s+([01]\d|2[0-3]):?([0-5]\d)\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+([0-2]?\d|3[01])\s+([a-z]{3,9})(?:\s+(\d{4}))?\s+(?:to|until)\s+([01]\d|2[0-3]):?([0-5]\d)\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+([0-2]?\d|3[01])\s+([a-z]{3,9})(?:\s+(\d{4}))?\b/i,
  );
  const affected = String(description).match(/:\s*([^:]+?)\s+valid\s+from\b/i)?.[1] ?? "";
  if (!validity || !affected) return null;

  const startMonth = MONTHS.get(validity[4].slice(0, 3).toLowerCase());
  const endMonth = MONTHS.get(validity[9].slice(0, 3).toLowerCase());
  const anchor = warningAnchor(url, parsedPublishedDate);
  if (!startMonth || !endMonth || anchor == null) return null;

  const explicitStartYear = validity[5] ? Number(validity[5]) : null;
  const explicitEndYear = validity[10] ? Number(validity[10]) : null;
  const anchorYear = new Date(anchor).getUTCFullYear();
  const candidateYears = explicitStartYear == null
    ? [anchorYear - 1, anchorYear, anchorYear + 1]
    : [explicitStartYear];
  const candidates = [];

  for (const startYear of candidateYears) {
    const start = ukLocalInstant({
      year: startYear,
      month: startMonth,
      day: Number(validity[3]),
      hour: Number(validity[1]),
      minute: Number(validity[2]),
    });
    if (start == null) continue;
    let endYear = explicitEndYear ?? startYear;
    let end = ukLocalInstant({
      year: endYear,
      month: endMonth,
      day: Number(validity[8]),
      hour: Number(validity[6]),
      minute: Number(validity[7]),
    });
    if (explicitEndYear == null && end != null && end <= start) {
      endYear += 1;
      end = ukLocalInstant({
        year: endYear,
        month: endMonth,
        day: Number(validity[8]),
        hour: Number(validity[6]),
        minute: Number(validity[7]),
      });
    }
    if (end == null || end <= start || end - start > 14 * 24 * 60 * 60 * 1_000) continue;
    const distance = anchor < start ? start - anchor : anchor > end ? anchor - end : 0;
    candidates.push({ start, end, distance });
  }
  const selected = candidates.sort((a, b) => a.distance - b.distance)[0];
  if (!selected) return null;

  const regions = affected
    .split(/[,;|]/)
    .map((value) => plainText(value, 100))
    .filter(Boolean)
    .slice(0, 30);
  if (!regions.length) return null;
  return {
    validFrom: new Date(selected.start).toISOString(),
    validUntil: new Date(selected.end).toISOString(),
    regions,
  };
}

export function isDirectMetOfficeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "metoffice.gov.uk" || url.hostname.endsWith(".metoffice.gov.uk"));
  } catch {
    return false;
  }
}

export function stableId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

export function parseRss(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("RSS input is empty");
  const hasRssRoot = /<rss\b[^>]*>[\s\S]*<\/rss>/i.test(xml) && /<channel\b[^>]*>/i.test(xml);
  const hasAtomRoot = /<feed\b[^>]*>[\s\S]*<\/feed>/i.test(xml);
  if (!hasRssRoot && !hasAtomRoot) {
    throw Object.assign(new Error("RSS input has no recognised feed root"), { code: "rss-invalid-root" });
  }
  const hasFeedTitle = hasRssRoot
    ? /<channel\b[^>]*>[\s\S]*?<title\b[^>]*>[\s\S]*?<\/title>/i.test(xml)
    : /<feed\b[^>]*>[\s\S]*?<title\b[^>]*>[\s\S]*?<\/title>/i.test(xml);
  if (!hasFeedTitle) {
    throw Object.assign(new Error("RSS input has no feed title metadata"), { code: "rss-missing-metadata" });
  }
  const blocks = [
    ...(xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? []),
    ...(xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? []),
  ];
  return blocks
    .map((block) => {
      const title = plainText(tagValue(block, ["title"]), 300);
      const url = linkValue(block);
      const rawDate = plainText(tagValue(block, ["pubDate", "published", "updated", "dc:date"]), 100);
      const parsedDate = Date.parse(rawDate);
      const description = plainText(tagValue(block, ["description", "summary", "content:encoded", "content"]), 1_000);
      const rawValidFrom = plainText(tagValue(block, ["cap:effective", "effective", "validFrom", "valid-from"]), 100);
      const rawValidUntil = plainText(tagValue(block, ["cap:expires", "expires", "validUntil", "valid-until"]), 100);
      const rawRegions = plainText(tagValue(block, ["cap:areaDesc", "areaDesc", "regions", "affectedAreas"]), 500);
      const descriptionFrom = description.match(/\bvalid\s+from\s*:\s*(\d{4}-\d{2}-\d{2}T[^\s,;]+)/i)?.[1] ?? "";
      const descriptionUntil = description.match(/\bvalid\s+(?:until|to)\s*:\s*(\d{4}-\d{2}-\d{2}T[^\s,;]+)/i)?.[1] ?? "";
      const descriptionRegions = description.match(/\b(?:affected\s+(?:areas|regions)|regions?)\s*:\s*([^.;]+)/i)?.[1] ?? "";
      const humanDetails = humanWarningDetails(description, url, parsedDate);
      const validFromSource = rawValidFrom || descriptionFrom;
      const validUntilSource = rawValidUntil || descriptionUntil;
      const validFromDate = Date.parse(validFromSource);
      const validUntilDate = Date.parse(validUntilSource);
      const regionSource = rawRegions || descriptionRegions;
      const regions = regionSource
        ? regionSource
          .split(/[,;|]/)
          .map((value) => plainText(value, 100))
          .filter(Boolean)
          .slice(0, 30)
        : (humanDetails?.regions ?? []);
      if (!title || !isDirectMetOfficeUrl(url)) return null;
      return {
        id: stableId(url),
        title,
        url,
        publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
        description,
        validFrom: Number.isFinite(validFromDate) ? new Date(validFromDate).toISOString() : humanDetails?.validFrom ?? null,
        validUntil: Number.isFinite(validUntilDate) ? new Date(validUntilDate).toISOString() : humanDetails?.validUntil ?? null,
        regions,
      };
    })
    .filter(Boolean);
}

export function wordCount(value) {
  return String(value).trim().split(/\s+/u).filter(Boolean).length;
}

export function classifyTopics(value) {
  const text = String(value).toLowerCase();
  const topics = [];
  const patterns = {
    heat: /\b(heat|hot|temperature|warm)\b/,
    cold: /\b(cold|ice|frost|freez)\w*\b/,
    snow: /\b(snow|blizzard)\w*\b/,
    rain: /\b(rain|downpour|showers?)\b/,
    flooding: /\b(flood|flooding)\b/,
    wind: /\b(wind|gust|gale)\w*\b/,
    storms: /\b(storm|thunder|lightning)\w*\b/,
    "severe-weather": /\b(warning|severe|danger|impact)\w*\b/,
  };
  for (const [topic, pattern] of Object.entries(patterns)) if (pattern.test(text)) topics.push(topic);
  return topics.length ? topics : ["weather"];
}

export function warningSeverity(value) {
  const text = String(value).toLowerCase();
  if (/\bred\b/.test(text)) return "red";
  if (/\bamber\b/.test(text)) return "amber";
  if (/\byellow\b/.test(text)) return "yellow";
  return "unknown";
}
