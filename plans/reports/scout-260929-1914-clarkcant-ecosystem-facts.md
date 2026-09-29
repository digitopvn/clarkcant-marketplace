# ClarkCant ecosystem facts for the Marketplace bootstrap

Source repos: `D:\www\digitop\clarkcant` (runtime monorepo), `D:\www\digitop\clarkcant-web` (landing, domain `clarkcant.cc`).

## Widget package manifest (`clarkcant.json`)
Canonical Zod schema: `clarkcant/packages/contracts/src/install.ts` → `packageManifestSchema`. Mirror it (do not import) in marketplace contracts.
- `schemaVersion: 1`; `id` (1-160, reverse-domain e.g. `com.example.frame-widget`); `version` (semver ≤80); `displayName`; `description`
- `hostApi: { min:int, max:int }` with min ≤ max
- `facets[]` (1-64): `kind` widget|tools|skills|prompts|themes|setup|driver|voice; `entry` (≤300); `isolation` declarative|service|isolated-ui|trusted-native; optional `widgetId`, `renderer` catalog|isolated-app|mcp-app
- `requestedCapabilities: string[]` (≤128, `namespace.name@major`)
- `permissions: { networkOrigins: string[]≤64, filesystem: {path, access: read|write}[]≤64, microphone: bool, camera: bool, lifecycleScripts: string[]≤32 }`
- `platforms: (darwin-arm64|linux-x64|win32-x64|web)[]` min 1
- optional `publisher: { id, sourceUrl, license, signature? }`; `dependencies: {id, version}[]` exact versions
- Per-widget `widgets/<name>/widget.json` (`packages/contracts/src/widgets.ts`): id, version, renderer, propsSchema, semanticDescription (≤400), textFallback, sizing, requestedCapabilities, effectCategories…
- Fixture example: `clarkcant/apps/web/e2e/fixtures/frame-widget/clarkcant.json` (also chart-widget, dashboard-widget)
- Package layout: package.json, clarkcant.json, README.md, LICENSE, widgets/main/{index.html,widget.json}, fixtures/, previews/{cover.webp,demo.mp4}

## Publishing / install
- `clark widget init|test|pack|dev|publish` (`packages/widget-cli/src/cli.ts`). Discovery keywords (convention to adopt): `clarkcant`, `clarkcant-widget`.
- ClarkCant install: resolve source → verify digest → consent (risk lane + capabilities) → activate. npm source = `{ name, version }` exact only (`packages/contracts/src/directory.ts`).
- Marketplace UI must show source, version, digest, risk lane (isolation), capabilities. Lanes labelled distinctly: declarative, service, isolated-ui, trusted-native.
- No `clarkcant://` deep-link exists yet → Marketplace defines the Open-in-ClarkCant contract (coordinate `{package, version, source:"npm"}`) plus copy fallback.

## Identity
- Local principals `prin_<alnum>` with kind user|client|peer-node|pack|conductor|worker (`packages/contracts/src/grants.ts`). Identity from authenticated transport only. No OAuth/OIDC in ClarkCant yet.

## Brand (clarkcant-web/assets/css/tokens.css, DESIGN.md)
- Name "ClarkCant". Fonts: Instrument Serif (display), Geist (sans), Geist Mono.
- Light: bg #f6f5f2, text #17171a, accent #6b5fa8, accent-soft #ece9f7. Dark: bg #0c0d11, raised #111217, text #eff1f5, accent #8e6cff. success #3f6b52, warning #7a5b1e, focus #5b4fa0.
- Spectrum: linear-gradient(90deg,#82f4ff 0%,#fff 22%,#ffd86b 45%,#ff7bff 72%,#8e6cff 100%)
- Radius 10/16/24/999px. Motion 140/240/700ms, ease-out cubic-bezier(0.22,1,0.36,1).
- Tone: "feel simpler than the system underneath"; progressive disclosure; honest UI (no fake buttons, no claiming live for cached data).
- Assets: clarkcant-web/assets/img/favicon.svg, og-image.png.

## Tooling conventions
- pnpm, Node ≥22 (24 in CI), exact-pinned deps, TS strict, no enum/namespace/param-properties, workspace packages resolve to src/index.ts (no build step), Vitest + Playwright, conventional commits without AI references.
