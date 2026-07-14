import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE = path.join(ROOT, "weatherchart");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "deploy.yml");
const SITE_BASE = new URL("https://brexatlas.github.io/WeatherChartUK/");
const COOL_ISLE_BASE = "https://brexatlas.github.io/Cool-Isle/";

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, predicate) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute, predicate));
    else if (predicate(absolute)) output.push(absolute);
  }
  return output;
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(
    "(?:^|[\\s<])" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i",
  ));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function hasAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  return new RegExp("(?:^|[\\s<])" + escaped + "(?:\\s|=|>)", "i").test(tag);
}

function metaContent(html, attribute, value) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((getAttribute(tag, attribute) ?? "").toLowerCase() === value.toLowerCase()) {
      return getAttribute(tag, "content");
    }
  }
  return null;
}

function referencesIn(html) {
  const withoutScriptBodies = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1</script>");
  const tags = withoutScriptBodies.match(/<(?:a|link|script|img|source|form|video|use)\b[^>]*>/gi) ?? [];
  const entries = [];
  for (const tag of tags) {
    for (const attribute of ["href", "src", "action", "poster", "srcset"]) {
      const value = getAttribute(tag, attribute);
      if (!value) continue;
      const references = attribute === "srcset"
        ? value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
        : [value];
      for (const reference of references) entries.push({ tag, attribute, reference });
    }
  }
  return entries;
}

function isExternal(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference);
}

async function resolveSiteReference(fromFile, reference) {
  const pathPart = reference.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    assert.fail(path.relative(ROOT, fromFile) + " contains a malformed URL escape: " + reference);
  }

  let target;
  if (!decoded) {
    target = fromFile;
  } else if (decoded.startsWith("/WeatherChartUK/")) {
    target = path.join(SITE, decoded.slice("/WeatherChartUK/".length));
  } else if (decoded.startsWith("/")) {
    assert.fail(path.relative(ROOT, fromFile) + " has an unexpected site-root path: " + reference);
  } else {
    target = path.resolve(path.dirname(fromFile), decoded);
  }

  assert.ok(
    target === SITE || target.startsWith(SITE + path.sep),
    path.relative(ROOT, fromFile) + " escapes the WeatherChart artifact root: " + reference,
  );
  try {
    if ((await fs.stat(target)).isDirectory()) target = path.join(target, "index.html");
  } catch {
    // The assertion below gives the useful source and target.
  }
  assert.equal(
    await exists(target),
    true,
    path.relative(ROOT, fromFile) + " points to missing " + path.relative(ROOT, target) + " via " + reference,
  );
  return target;
}

function idsIn(html) {
  return [...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

async function htmlFiles() {
  return (await fs.readdir(SITE))
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => path.join(SITE, name));
}

function expectedPageUrl(filePath) {
  const name = path.basename(filePath);
  return name === "index.html" ? SITE_BASE.href : new URL(name, SITE_BASE).href;
}

test("every standalone page and local asset resolves from the Pages artifact root", async () => {
  const pages = await htmlFiles();
  assert.ok(pages.length >= 9, "Expected the complete WeatherChart page set, including the cookie policy");
  assert.equal(await exists(path.join(SITE, "index.html")), true);
  assert.equal(await exists(path.join(SITE, "cookies.html")), true);

  for (const page of pages) {
    const html = await read(page);
    for (const { reference } of referencesIn(html)) {
      assert.doesNotMatch(reference, /^(?:javascript|vbscript):/i, "Unsafe URL scheme in " + path.basename(page));
      if (isExternal(reference)) continue;
      const target = await resolveSiteReference(page, reference);
      const fragment = reference.includes("#") ? decodeURIComponent(reference.slice(reference.indexOf("#") + 1)) : "";
      if (fragment && path.extname(target).toLowerCase() === ".html") {
        assert.ok(new Set(idsIn(await read(target))).has(fragment), `${path.basename(page)} links to missing #${fragment}`);
      }
    }
  }
});

test("browser modules, styles, manifest assets, and public data contracts resolve", async () => {
  for (const jsFile of await walk(path.join(SITE, "assets", "js"), (file) => file.endsWith(".js"))) {
    const source = await read(jsFile);
    const imports = [
      ...[...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
    ];
    for (const specifier of new Set(imports)) {
      assert.ok(specifier.startsWith("."), "Browser module uses a bare import: " + specifier);
      assert.equal(await exists(path.resolve(path.dirname(jsFile), specifier)), true, "Missing module " + specifier);
    }
  }

  for (const cssFile of await walk(path.join(SITE, "assets", "css"), (file) => file.endsWith(".css"))) {
    const css = await read(cssFile);
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (!isExternal(match[1]) && !match[1].startsWith("data:")) {
        await resolveSiteReference(cssFile, match[1]);
      }
    }
  }

  const manifestPath = path.join(SITE, "manifest.webmanifest");
  const manifest = JSON.parse(await read(manifestPath));
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  for (const icon of manifest.icons ?? []) await resolveSiteReference(manifestPath, icon.src);

  for (const name of ["forecast.json", "warnings.json", "news.json", "community.json", "status.json"]) {
    assert.equal(await exists(path.join(SITE, "data", name)), true, "Missing public data contract " + name);
  }
});

test("all pages carry standalone metadata, privacy controls, and a Cool Isle return link", async () => {
  const titles = new Set();
  for (const page of await htmlFiles()) {
    const name = path.basename(page);
    const html = await read(page);
    assert.match(html, /<meta\s+charset=["']utf-8["']/i, name + " lacks UTF-8 metadata");
    assert.ok(metaContent(html, "name", "viewport"), name + " lacks viewport metadata");
    assert.ok(metaContent(html, "name", "description"), name + " lacks a description");
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
    assert.ok(title, name + " lacks a title");
    assert.equal(titles.has(title), false, "Duplicate title: " + title);
    titles.add(title);

    const ids = idsIn(html);
    assert.equal(new Set(ids).size, ids.length, name + " has duplicate IDs");
    assert.match(html, /assets\/css\/privacy-choices\.css/, name + " does not load privacy-choice styles");
    assert.match(html, /data-privacy-settings/, name + " lacks a permanent privacy settings control");

    const coolIsleLink = referencesIn(html).find(({ tag }) => hasAttribute(tag, "data-cool-isle-link"));
    assert.ok(coolIsleLink, name + " lacks a Cool Isle cross-promotion link");
    assert.equal(coolIsleLink.reference, COOL_ISLE_BASE, name + " has a non-portable Cool Isle fallback link");

    if (name === "404.html") {
      assert.match(metaContent(html, "name", "robots") ?? "", /noindex/i);
    } else {
      const canonicalTag = (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i) ?? [])[0];
      const canonical = canonicalTag ? getAttribute(canonicalTag, "href") : null;
      assert.equal(canonical, expectedPageUrl(page), name + " has the wrong standalone canonical URL");
      assert.equal(metaContent(html, "property", "og:url"), canonical, name + " has a mismatched og:url");
    }

    const csp = metaContent(html, "http-equiv", "Content-Security-Policy");
    assert.ok(csp, name + " lacks a Content Security Policy");
    assert.match(csp, /default-src\s+'self'/);
    assert.match(csp, /object-src\s+'none'/);
    assert.match(csp, /frame-src\s+'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  }
});

test("production data is live, complete, and contains no credential fields", async () => {
  const dataDirectory = path.join(SITE, "data");
  const bundle = Object.fromEntries(await Promise.all(
    ["forecast", "warnings", "news", "community", "status"].map(async (name) => [
      name,
      JSON.parse(await read(path.join(dataDirectory, `${name}.json`))),
    ]),
  ));

  assert.equal(bundle.forecast.sample, false, "Production forecast is marked as sample data");
  assert.equal(bundle.forecast.locations?.length, 12, "Forecast must contain the complete 12-location batch");
  assert.ok(Number.isFinite(Date.parse(bundle.forecast.generatedAt ?? "")), "Forecast timestamp is invalid");
  assert.notEqual(bundle.status.provider?.mode, "sample");
  assert.doesNotMatch(bundle.status.forecastState ?? "", /sample|placeholder|demo/i);
  for (const name of ["warnings", "news", "community"]) {
    assert.equal(bundle[name].sample, false, `${name}.json is marked as sample data`);
  }

  const publicJson = JSON.stringify(bundle);
  assert.doesNotMatch(publicJson, /"(?:api[_-]?key|authorization|secret|bearer[_-]?token)"\s*:/i);
  assert.doesNotMatch(publicJson, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
});

test("the consent-gated map and six-month privacy choice are wired into every page", async () => {
  const app = await read(path.join(SITE, "assets", "js", "app.js"));
  const privacy = await read(path.join(SITE, "assets", "js", "privacy-choices.js"));
  const map = await read(path.join(SITE, "assets", "js", "map.js"));
  assert.match(app, /import\s+["']\.\/privacy-choices\.js["']/);
  assert.match(privacy, /weatherchart\.privacy\.v1/);
  assert.match(privacy, /180\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(privacy, /Reject optional maps/i);
  assert.match(privacy, /Allow optional maps/i);
  assert.match(map, /optionalMapsAllowed/);
  assert.match(map, /privacychoicechange/);

  for (const page of await htmlFiles()) {
    const html = await read(page);
    assert.doesNotMatch(html, /<(?:link|script)\b[^>]*leaflet(?:@|\.)/i, "Leaflet must not load eagerly in HTML");
    assert.match(html, /<script\s+type=["']module["']\s+src=["']assets\/js\/app\.js["']/i);
  }
});

test("robots and sitemap advertise the new GitHub Pages site only", async () => {
  const robots = await read(path.join(SITE, "robots.txt"));
  assert.match(robots, /^User-agent:\s*\*/m);
  assert.match(robots, /^Allow:\s*\/(?:WeatherChartUK\/)?\s*$/m);
  assert.match(robots, /Sitemap:\s*https:\/\/brexatlas\.github\.io\/WeatherChartUK\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Cool-Isle\/weatherchart|weatherchart\.uk/i);

  const sitemap = await read(path.join(SITE, "sitemap.xml"));
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.ok(locations.length >= 8, "Sitemap omits WeatherChart pages");
  assert.equal(new Set(locations).size, locations.length, "Sitemap contains duplicate URLs");
  assert.equal(locations.some((location) => /404\.html/.test(location)), false);
  assert.ok(locations.includes(new URL("cookies.html", SITE_BASE).href), "Cookie policy is missing from the sitemap");
  for (const location of locations) {
    const url = new URL(location);
    assert.equal(url.origin, SITE_BASE.origin);
    assert.ok(url.pathname.startsWith(SITE_BASE.pathname), "Sitemap URL escaped /WeatherChartUK/");
    const relative = decodeURIComponent(url.pathname.slice(SITE_BASE.pathname.length));
    const target = relative ? path.join(SITE, relative) : path.join(SITE, "index.html");
    assert.equal(await exists(target), true, "Sitemap URL has no source artifact: " + location);
  }
});

test("deployment is the sole hourly caller and fails closed until quota is bootstrapped", async () => {
  const workflow = await read(WORKFLOW);
  const prepareStart = workflow.indexOf("  prepare:");
  const deployStart = workflow.indexOf("  deploy:");
  const prepare = workflow.slice(prepareStart, deployStart);
  const deploy = workflow.slice(deployStart);

  assert.match(workflow, /cron:\s*['"]17 \* \* \* \*['"]/);
  assert.match(workflow, /bootstrap_date:/);
  assert.match(workflow, /bootstrap_calls_used:/);
  assert.match(workflow, /confirm_quota_bootstrap:/);
  assert.match(prepare, /bootstrap-weather-quota\.mjs/);
  assert.match(prepare, /WEATHERCHART_REQUIRE_DURABLE_QUOTA:\s*['"]true['"]/);
  assert.match(prepare, /WEATHERCHART_REQUIRE_LIVE_FORECAST:\s*['"]true['"]/);
  assert.match(prepare, /WEATHERCHART_QUOTA_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.equal((workflow.match(/secrets\.MET_OFFICE_API_KEY/g) ?? []).length, 1);
  assert.match(prepare, /secrets\.MET_OFFICE_API_KEY/);
  assert.doesNotMatch(deploy, /MET_OFFICE_API_KEY|WEATHERCHART_QUOTA_TOKEN/);
  assert.match(prepare, /https:\/\/brexatlas\.github\.io\/WeatherChartUK\/data\//);
  assert.match(prepare, /weatherchart\/\s+"\$RUNNER_TEMP\/pages-site\/"/);
  assert.match(prepare, /--exclude='data\/sample\/'/);
  assert.match(prepare, /\.nojekyll/);

  const deploymentIndex = workflow.indexOf("- name: Deploy to GitHub Pages");
  const persistIndex = workflow.indexOf("Persist the successfully deployed private snapshot");
  assert.ok(deploymentIndex > 0 && persistIndex > deploymentIndex, "Private state must persist only after Pages succeeds");
  assert.doesNotMatch(workflow.slice(0, deploymentIndex), /actions\/cache\/save/);
  assert.doesNotMatch(workflow.slice(persistIndex), /if:\s*always\(\)/);

  const constants = await read(path.join(ROOT, "scripts", "lib", "constants.mjs"));
  assert.match(constants, /DAILY_ATTEMPT_LIMIT\s*=\s*350\s*;/);
  assert.match(constants, /REQUIRED_BATCH_SIZE\s*=\s*12\s*;/);
  const durableStore = await read(path.join(ROOT, "scripts", "lib", "durable-quota-store.mjs"));
  assert.match(durableStore, /missing-durable-state-quarantine/);
  assert.match(durableStore, /attempts:\s*DAILY_ATTEMPT_LIMIT/);
});
