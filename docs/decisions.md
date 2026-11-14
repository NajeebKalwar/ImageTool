# ImageTool — Architecture Decision Record

This file is the source of truth for project-level decisions. Add a dated entry whenever a decision changes. Do not silently change an established decision in code.

## ADR-001: Production site origin and URL format

- **Status:** Provisional — replace the placeholder before production.
- **Problem:** Astro needs a production origin to generate absolute canonical URLs and sitemap entries. The project does not yet have a confirmed production domain.
- **Principle:** Keep one source of truth for the origin in `astro.config.mjs`; do not duplicate it in `src/site.config.ts`.
- **Decision:** Use `https://imagetool.example` as an explicitly non-production placeholder. Set `trailingSlash: 'never'` and `build.format: 'file'` so Astro emits extensionless route URLs without trailing slashes (for example, `/background-remover`) and writes page files such as `background-remover.html`.
- **Options rejected:** Guessing a real domain; maintaining the origin independently in multiple configuration files; pairing `trailingSlash: 'never'` with the default directory output format.
- **Risk:** The placeholder is unsuitable for indexing or production sharing. Replace it with the owned production origin before launch. The selected output format must be tested against the eventual static host: it must serve `/background-remover` from the generated `background-remover.html` without redirecting to a slash URL. This host behavior has not yet been tested.

## ADR-002: Global site configuration

- **Status:** Accepted.
- **Problem:** Shared site metadata should not be repeated or mixed with page-specific SEO data.
- **Principle:** A global config contains only values that remain the same across pages. Titles, descriptions, canonical paths, robots directives, and page-specific images belong to individual pages.
- **Decision:** Create `src/site.config.ts` for the site name, default language, and default social-image path. The production origin remains in `astro.config.mjs` to avoid configuration drift. The current `defaultSocialImage` value (`/images/social/default-og.png`) is a placeholder for a file that has not been created yet; before Phase 4 uses it, create the image and resolve it to an absolute URL using `Astro.site`.
- **Options rejected:** Putting per-page SEO fields in the global config; duplicating the production origin.
- **Risk:** Shared defaults may be mistaken for required page metadata. Page-level metadata must remain explicit, and the social image must exist before it is emitted.

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
- **Decision:** Use Astro for the website shell, static page generation, metadata, sitemap, and content; use React + TypeScript for interactive tools. Per-page title and description are required by the SEO layout.
- **Options rejected:** A client-only SPA as the entire public website.
- **Risk:** Client-rendered content, duplicate URL forms, missing metadata, and thin tool pages can undermine discoverability. Validate built HTML and provide useful, original content on each tool page.

## ADR-005: Repository hygiene

- **Status:** Accepted.
- **Problem:** Prevent generated files, secrets, and personal data from entering version control.
- **Principle:** Commit only intentional project source and documentation; never commit credentials or private user data.
- **Decision:** Keep `dist/`, `.astro/`, `node_modules/`, environment files, logs, and common OS/IDE artifacts ignored. No project license is selected yet.
- **Options rejected:** Committing generated build output, local environment files, API keys, or personal files.
- **Risk:** Ignore rules do not remove files already tracked. Review tracked files and repository history for accidental secrets before public release. Select a license before publishing or accepting contributions.

## ADR-006: Robots indexing policy

- **Status:** Accepted.
- **Problem:** Preview and development builds must not accidentally become indexable, while selected production pages may need to be excluded.
- **Principle:** The deployment environment provides the mandatory safety boundary; a page may make indexing stricter but cannot make a non-production build indexable.
- **Decision:** The SEO layout treats the build as production only when the server-side `SITE_ENV` variable equals `production`. If it is unset or has any other value, emit `noindex, nofollow`. An optional page-level `noindex: true` prop can also exclude a page in production. Production deployment must explicitly set `SITE_ENV=production`; preview deployments must not set it to production.
- **Options rejected:** Relying only on a page author to remember `noindex`; allowing a page prop to override a preview build's noindex protection.
- **Risk:** A deployment configured with `SITE_ENV=production` on a preview URL will be indexable. Configure this variable per deployment environment and verify the generated HTML before publishing.
