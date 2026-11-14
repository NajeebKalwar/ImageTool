# ImageTool — Architecture Decision Record

This file is the source of truth for project-level decisions. Add a dated entry whenever a decision changes. Do not silently change an established decision in code.

## ADR-001: Production site origin and URL format

- **Status:** Provisional — replace the placeholder before production.
- **Problem:** Astro needs a production origin to generate absolute canonical URLs and sitemap entries. The project does not yet have a confirmed production domain.
- **Principle:** Keep one source of truth for the origin in `astro.config.mjs`; do not duplicate it in `src/site.config.ts`.
- **Decision:** Use `https://imagetool.example` as an explicitly non-production placeholder. Set Astro's `trailingSlash` to `never`, so page routes and canonical URLs use paths such as `/background-remover`.
- **Options rejected:** Guessing a real domain; maintaining the origin independently in multiple configuration files; allowing both slash forms without a canonical policy.
- **Risk:** Every absolute URL generated with the placeholder is unsuitable for indexing or production sharing. Replace it with the owned production origin before launch and verify canonical and sitemap output. Astro's build output format must be checked against the chosen route policy.

## ADR-002: Global site configuration

- **Status:** Accepted.
- **Problem:** Shared site metadata should not be repeated or mixed with page-specific SEO data.
- **Principle:** A global config contains only values that remain the same across pages. Titles, descriptions, canonical paths, robots directives, and page-specific images belong to individual pages.
- **Decision:** Create `src/site.config.ts` for the site name, default language, and default social-image path. The production origin remains in `astro.config.mjs` to avoid configuration drift.
- **Options rejected:** Putting per-page SEO fields in the global config; duplicating the production origin.
- **Risk:** Shared defaults may be mistaken for required page metadata. Page-level metadata must remain explicit.

## ADR-003: Image privacy boundary

- **Status:** Accepted as a product requirement; implementation verification is ongoing.
- **Problem:** The product's main promise is that image pixels stay on the visitor's device.
- **Principle:** Local image processing is the default. Any future feature that sends image pixels off-device must be treated as a product/privacy decision, not an incidental implementation detail.
- **Decision:** Image inputs and decoded pixel data are processed in the browser. AI inference runs locally in a Web Worker using browser-compatible runtimes where supported. Model downloads may contact a model or asset host, but user image pixels must not be included in those requests.
- **Options rejected:** A server-side image inference service as the default; uploading source images for routine processing.
- **Risk:** Third-party scripts, analytics, crash reporting, remote fonts/widgets, model-loading code, or a future sharing/cloud feature could violate the promise. See `ARCHITECTURE.md` for detection requirements. Verify actual network behavior before making privacy claims publicly.

## ADR-004: SEO framework and rendering

- **Status:** Accepted.
- **Problem:** Tool pages need crawlable HTML and individually correct metadata.
- **Principle:** Render page content and essential SEO metadata at build time wherever possible; keep interactive image tools in React islands.
- **Decision:** Use Astro for the website shell, static page generation, metadata, sitemap, and content; use React + TypeScript for interactive tools. Per-page title and description will be required when the SEO layout is implemented.
- **Options rejected:** A client-only SPA as the entire public website.
- **Risk:** Client-rendered content, duplicate URL forms, missing metadata, and thin tool pages can undermine discoverability. Validate built HTML and provide useful, original content on each tool page.

## ADR-005: Repository hygiene

- **Status:** Accepted.
- **Problem:** Prevent generated files, secrets, and personal data from entering version control.
- **Principle:** Commit only intentional project source and documentation; never commit credentials or private user data.
- **Decision:** Keep `dist/`, `.astro/`, `node_modules/`, environment files, logs, and common OS/IDE artifacts ignored. No project license is selected yet.
- **Options rejected:** Committing generated build output, local environment files, API keys, or personal files.
- **Risk:** Ignore rules do not remove files already tracked. Review tracked files and repository history for accidental secrets before public release. Select a license before publishing or accepting contributions.
