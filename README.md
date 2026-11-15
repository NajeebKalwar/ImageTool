# ImageTool

Browser-based image tools in early development.

The product is being designed around local image processing: image operations should run in the visitor's browser, with Web Workers for expensive work. The interactive editor will use React islands within an Astro website.

> **Privacy status:** Local processing is an architectural requirement, but the full network and third-party integration audit is not yet complete. Do not treat the privacy boundary as independently verified until the checks in [ARCHITECTURE.md](ARCHITECTURE.md) are complete.

## Project status

The project currently has its Astro foundation, shared SEO layout, production/preview robots rules, sitemap generation, automated SEO verification, and CI checks. Image tools and worker processing are being developed phase by phase.

## Stack

- [Astro](https://astro.build) for the public website, static pages, metadata, and content
- [React](https://react.dev) and TypeScript for interactive tools
- [Tailwind CSS](https://tailwindcss.com) for styling
- Web Workers for expensive image processing
- ONNX Runtime Web is planned for browser-based AI inference

## Getting started

Requires Node.js 22.23.4 or newer.

```bash
npm ci
npm run dev
```

## Verification

```bash
npm run test:verify
npm run test:integration
npm run build
npm run verify:preview
```

Production-style build in PowerShell:

```powershell
$env:SITE_ENV = "production"
npm run build
npm run verify:production
Remove-Item Env:SITE_ENV
```

Set SITE_ENV=production only in the real production build environment. Without it, pages are emitted with noindex, nofollow and no production sitemap is generated.

The production origin in astro.config.mjs is currently a placeholder (https://imagetool.example). Replace it with the owned domain before launch.

## Project documentation

- [Architecture and privacy requirements](ARCHITECTURE.md)
- [Architecture decision records](docs/decisions.md)

## License

No license has been selected yet. Until a license is added, do not assume that the repository grants permission to reuse, modify, or distribute its code.
