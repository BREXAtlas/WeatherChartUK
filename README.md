# WeatherChart UK

WeatherChart UK is a static, accessible UK weather dashboard published at
[brexatlas.github.io/WeatherChartUK](https://brexatlas.github.io/WeatherChartUK/).
It presents current hourly conditions for 12 UK locations, Met Office warnings
and news, clearly attributed public community reports, and weather explainers.

The companion site is [Cool Isle](https://brexatlas.github.io/Cool-Isle/), which
offers practical hot- and cold-weather guidance. Both sites link clearly to the
other.

## Live-data policy

- Forecasts are refreshed at minute 17 of each hour by GitHub Actions.
- The preferred source is the Met Office Weather DataHub site-specific hourly
  endpoint. Open-Meteo is a disclosed live fallback when the preferred source
  cannot return a complete batch.
- The site publishes no demo or placeholder forecast as production data. A
  deployment must pass `--require-live-forecast` validation.
- Warnings and news come from official Met Office RSS feeds. Community items
  are public, attributed, family-safe links; empty results stay empty rather
  than being replaced with synthetic chatter.

### Met Office quota safety

The pipeline enforces a hard maximum of **350 upstream attempts per UTC day**.
Each official refresh reserves one complete 12-location batch before making any
request, so the largest usable total is 348 attempts. A credential-free durable
ledger lives on the non-deployment branch `weatherchart-quota-state`; it is not
part of the Pages artifact. As with every branch of a public repository, its
quota counts and audit metadata are public, but it never contains the API key.

Missing durable state fails closed. The first run creates a 350/350 quarantine
record and makes no Met Office calls. An operator must then run the workflow
manually with:

1. `confirm_quota_bootstrap` enabled;
2. `bootstrap_date` set to the current UTC date (`YYYY-MM-DD`); and
3. `bootstrap_calls_used` set to the verified or conservatively estimated number
   of calls already made by the same API credential that day.

Never lower a known count. The bootstrap can replace only a same-day automatic
quarantine and cannot overwrite an active ledger.

## Repository layout

```text
weatherchart/       Static site source and generated public data
scripts/            Data refresh, validation, and quota-safety pipeline
tests/              Unit, pipeline, and standalone-site contract tests
.github/workflows/  Hourly refresh and GitHub Pages deployment
```

GitHub Pages receives the **contents** of `weatherchart/` as its artifact root.
Source-only sample fixtures and private pipeline state are explicitly excluded.

## Local development

Node.js 22.22 or newer is recommended.

```bash
npm ci --ignore-scripts
npm test
npm run test:html
npm run validate:data
python -m http.server 4173 --directory weatherchart
```

Then open `http://localhost:4173/`. The checked-in live data is enough to test
the interface. Do not put credentials in browser code or public JSON.

To refresh data locally, copy `.env.example` to `.env`, keep `.env` untracked,
and export only the variables needed by the command. Local mock mode is for
pipeline development only and must never be deployed.

## GitHub configuration

Required repository secret:

- `MET_OFFICE_API_KEY` — consumed only by the data-preparation job and passed
  only to the forecast refresh step.

Optional repository secrets for additional attributed community sources:

- `YOUTUBE_API_KEY`
- `X_BEARER_TOKEN`

GitHub Actions needs read/write workflow permissions so the workflow-scoped
`github.token` can maintain the durable quota branch. GitHub Pages must use
**GitHub Actions** as its build and deployment source.

## Privacy and security

WeatherChart UK does not place analytics or advertising cookies. A first-visit
privacy control lets visitors allow or reject the optional interactive map; the
choice is stored locally for six months and can be changed from every page. The
forecast remains available without the map.

Secrets are excluded from the Pages artifact, generated data is scanned for
credential-shaped fields, external map resources are consent-gated, and the
site uses a restrictive Content Security Policy.

## Licence

Code in this repository is available under the [MIT License](LICENSE). External
weather data, map tiles, feeds, linked posts, and brand assets remain subject to
their respective providers' terms and attribution requirements.
