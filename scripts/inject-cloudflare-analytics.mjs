import fs from "node:fs/promises";
import path from "node:path";

const SITE_TOKEN = "b26be81c81d745c38673a1fbb50863a1";
const root = path.resolve(process.argv[2] ?? ".");
const excludedDirectories = new Set([".git", ".github", "docs", "node_modules", "scripts", "tests"]);

const beacon = `<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${SITE_TOKEN}"}'></script><!-- End Cloudflare Web Analytics -->`;

const beaconBlockPattern = /<!--\s*Cloudflare Web Analytics\s*-->[\s\S]*?<!--\s*End Cloudflare Web Analytics\s*-->/gi;
const beaconScriptPattern = /<script\b(?=[^>]*\bsrc\s*=\s*["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\?[^"']*)?["'])[^>]*>\s*<\/script>/gi;

function addCspSource(policy, directiveName, source) {
  const directives = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean);

  const index = directives.findIndex((directive) => directive.split(/\s+/, 1)[0] === directiveName);
  if (index === -1) {
    directives.push(`${directiveName} ${source}`);
  } else {
    const values = directives[index].split(/\s+/);
    if (!values.includes(source)) values.push(source);
    directives[index] = values.join(" ");
  }

  return directives.join("; ");
}

function allowCloudflareAnalyticsInCsp(html) {
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i,
    (metaTag) => metaTag.replace(
      /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i,
      (_match, quote, policy) => {
        let updated = addCspSource(policy, "script-src", "https://static.cloudflareinsights.com");
        updated = addCspSource(updated, "connect-src", "https://cloudflareinsights.com");
        return `content=${quote}${updated}${quote}`;
      },
    ),
  );
}

async function htmlFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await htmlFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".html")) output.push(absolute);
  }
  return output;
}

const files = await htmlFiles(root);
if (files.length === 0) throw new Error(`No HTML files found under ${root}`);

for (const file of files) {
  let html = await fs.readFile(file, "utf8");
  html = html.replace(beaconBlockPattern, "").replace(beaconScriptPattern, "");
  html = allowCloudflareAnalyticsInCsp(html);

  if (!/<\/body>/i.test(html)) throw new Error(`Missing </body> in ${file}`);
  html = html.replace(/\s*<\/body>/i, `\n${beacon}\n</body>`);

  if (!html.includes(SITE_TOKEN)) throw new Error(`Analytics token was not inserted into ${file}`);
  await fs.writeFile(file, html, "utf8");
}

console.log(`Injected WeatherChart UK Cloudflare Web Analytics into ${files.length} HTML file(s).`);
