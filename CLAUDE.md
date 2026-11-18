# SideDisplay

Self-hosted manager for read-only information displays (TVs, tablets, ePaper).
Bun + Elysia 2 server, SolidJS client, Drizzle 1.0 on SQLite, Biome.
`docs/development.md` describes the code layout and how to add an element.

## Commands

- `bun run dev`: server with `--watch` plus client rebuild on change
- `bun run demo`: sample content and a fake Home Assistant, throwaway data
- `bun test`, `bun run lint` (`lint:fix`), `bun run typecheck`: run all three before finishing a change
- `bun run build`: production client build into `dist/client`
- `bun run db:generate`: new migration after editing `src/server/db/schema.ts`
- `bun run docs`: regenerate `docs/elements.md` after changing `src/shared/elements.ts`
- `bun run screenshots`: regenerate `docs/screenshots/` (needs Chromium)

## Use Bun

- `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`; never node, npm, jest or vite.
- Bun loads `.env` itself; do not add dotenv.
- Prefer Bun APIs: `Bun.file`, `Bun.write`, `Bun.password`, `Bun.Image`, `Bun.XML`, `Bun.CookieMap`, `Bun.Glob`, `bun:sqlite`.
- Bun's API docs are in `node_modules/bun-types/docs/**.mdx`.

## Things that are easy to get wrong here

- **The client is not served with Bun's HTML imports.** `scripts/build.ts` bundles `src/client/index.html` (admin) and `display.html` (display page) into `dist/client`, and `src/server/routes/pages.ts` serves them with an injected `<base>` tag. All client URLs must stay relative (`api(...)`, `url(...)`, `mediaUrl(...)` in `src/client/lib/api.ts`) so Home Assistant ingress and path prefixes keep working.
- **Solid JSX is compiled by Babel** (`scripts/solid-plugin.ts`), only for files under `src/client/`.
- **Elysia 2**: route options come before the handler, `.get(path, options, handler)`. The `elysiajs` skill has the v2 reference.
- **Authentication is one gate** (`gate()` in `src/server/auth.ts`, wired in `app.ts`): every `/api/` path needs a session unless it is in `PUBLIC_API`. A new public route must be added there deliberately.
- **`/api/view/*` and `/media/*` are public.** Never return anything there that is not meant for a screen in a public room, and never accept more than ids.
- **Keys typed into an element stay on the server.** A field holding a key, token or private URL is marked `secret: true` in `src/shared/elements.ts`; `withoutSecrets()` in `src/server/store.ts` blanks it in what displays receive, and only the resolver sees it.
- **Containers** (`columns`, `grid`, `carousel`, `switch`) keep their children under the keys in `CHILD_KEY` (`src/shared/layout.ts`); `canHold()` says what may nest in what. No element may name a property after a common one (a test checks).
- **Elements are data-driven.** `src/shared/elements.ts` is the single source for defaults, editor fields and the docs. Stored layouts are normalised on read (`normalizeElements`), so adding a property needs no migration.
- **ePaper modes**: user-chosen colours go through `env.ink()`, pictures through `<Picture>`, and anything animated must have a static form when `env.lowColor()` is true.
- **MapLibre is not bundled**; it is copied to `dist/client/vendor/maplibre` and imported at runtime by the map element. pdf.js and hls.js are vendored the same way.
- `pkill -f` patterns that match your own command line kill your shell; stop background servers in a separate command.
