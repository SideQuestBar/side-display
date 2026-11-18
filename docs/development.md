# Development

## Run it

```sh
bun install
bun run dev      # server (restarts on change) + client (rebuilt on change)
bun run demo     # sample content and a simulated Home Assistant
```

`bun run dev` serves <http://localhost:4380> with data in `./data`. Reload the
browser after a client change.

```sh
bun test            # unit and API tests
bun run lint        # Biome (bun run lint:fix to apply fixes)
bun run typecheck
bun run build       # production client build in dist/client
```

Other scripts: `bun run docs` regenerates `docs/elements.md`,
`bun run screenshots` regenerates `docs/screenshots/` (needs Chrome or
Chromium), `bun run db:generate` creates a migration after a schema change.

## Layout of the code

```
src/
  shared/            Used by both sides; no DOM, no server APIs
    elements.ts      The element catalogue: defaults and editor fields
    types.ts         Layout, display and settings types
    layout.ts        Building, normalising and walking element trees
    time.ts          Schedules and opening hours, in any time zone
    color.ts         ePaper palettes and dithering
    markdown.ts      The small, safe Markdown renderer
    templates.ts     Starter layouts
  server/
    index.ts         Process entry: migrations, Home Assistant, listen
    app.ts           The Elysia app and the authentication gate
    auth.ts          Password, sessions, request gate
    store.ts         Layouts, playlists and displays (Drizzle), live-stream bookkeeping
    media.ts         Uploads, resizing, file serving
    events.ts        Pub/sub behind the displays' live streams
    onboarding.ts    First-run guide: suggested settings, place search
    ha/client.ts     Home Assistant WebSocket + REST
    mqtt/            MQTT: the packets, and the client that listens to topics
    data/            Server-side data for elements (weather, calendars…)
    routes/          auth, admin API, public display API, pages
    db/              Drizzle schema and connection
  client/
    display/         The renderer: Canvas, ElementBox, one renderer per element
    viewer.tsx       The display page (/d/<id>)
    admin/           The admin app: editor, pages, form fields
scripts/             build, dev, demo, docs, screenshots
test/                Tests, the fake Home Assistant and the fake MQTT broker
drizzle/             SQL migrations
sidedisplay/         Home Assistant app definition
```

## How the pieces talk

- The **admin app** (`/`) calls `/api/…`. Every `/api/` route requires the
  session cookie, enforced in one place (`gate()` in `auth.ts`) before the
  request body is even read. The exceptions are listed there.
- A **display page** (`/d/<id>`) calls `/api/view/<id>…`, which is public and
  read-only: the layouts of that display, the data of the elements on them, and
  a Server-Sent Events stream that says when to refetch.
- Elements that need **server data** (weather, calendars, Home Assistant, MQTT) have a
  resolver in `src/server/data/`. The display asks for an element's data by id;
  the editor sends the unsaved element instead. Secrets stay on the server.
- The client is built with **relative URLs** and the server injects a `<base>`
  tag, which is what makes Home Assistant ingress and path prefixes work.

## Adding an element

1. **Describe it** in `src/shared/elements.ts`: label, description, category,
   icon, default properties and form fields. Mark the less common fields
   `advanced: true`. The property types are inferred from the defaults.
2. **Render it**: add a component in `src/client/display/elements/` and
   register it in `elements/index.ts`. It receives `props.el` (typed as
   `El<"your-type">`). Use `px()` for text sizes and `useDisplay()` for the
   colour mode, locale and helpers.
3. **Style it** in `src/client/display/display.css` (classes start with `sd-`).
   Check it in the ePaper modes with the editor's colour-mode selector.
4. **If it needs server data**, set `data: <refresh seconds>` in its definition
   and add a resolver in `src/server/data/index.ts`. The renderer receives the
   result as `props.data()`.
5. Add its icon to `src/client/admin/icons.tsx`, then run `bun test` (a test
   checks every element against its definition) and `bun run docs`.

No migration is needed: layouts are stored as JSON and normalised when read, so
new properties get their defaults in existing layouts.

## Conventions

- Bun APIs first (`Bun.file`, `Bun.password`, `Bun.Image`, `Bun.XML`,
  `bun:sqlite`); no Node-only dependencies where Bun has an equivalent.
- Biome formats and lints; tabs, double quotes, 120 columns.
- Comments explain why, not what.

## Releasing

1. Set the version in `package.json` and `sidedisplay/config.yaml`, and add an
   entry to `sidedisplay/CHANGELOG.md`.
2. Commit, tag `v<version>` and push the tag. The _Release_ workflow builds the
   multi-architecture image and publishes it to `ghcr.io`, which is what Docker
   users and the Home Assistant app pull.
