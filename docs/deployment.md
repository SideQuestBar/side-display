# Deployment

SideDisplay is one container: it listens on port `4380` and keeps everything
(a SQLite database and your media) under `/data`.

## Docker Compose

```yaml
services:
  sidedisplay:
    image: ghcr.io/sidequestbar/side-display:latest
    restart: unless-stopped
    ports:
      - "4380:4380"
    volumes:
      - sidedisplay-data:/data
    environment:
      TZ: Europe/Budapest

volumes:
  sidedisplay-data:
```

```sh
docker compose up -d
```

To build the image yourself, replace `image:` with `build: .` in a checkout of
this repository.

The container starts as root only to make `/data` writable, then runs as the
unprivileged `bun` user. Starting it as another user (`user: "1000:1000"`)
works too, as long as that user can write to `/data`.

## Coolify

1. **New resource → Docker Image**, image
   `ghcr.io/sidequestbar/side-display:latest`.
   (Or **Public repository** with this repository and the _Dockerfile_ build
   pack.)
2. Set **Ports Exposes** to `4380`.
3. Under **Storages**, add a volume mounted at `/data`.
4. Give it a domain and deploy. Coolify's proxy handles HTTPS.

The health check is built into the image (`/api/health`).

## Behind a reverse proxy

Nothing special is needed for HTTPS termination. Two things to keep working:

- **Live updates** use Server-Sent Events on `/api/view/<id>/stream`. Do not
  buffer that path, and allow idle connections of at least 30 seconds (the
  server sends a heartbeat every 15).
- **Uploads** can be large: raise the proxy's body size limit if you upload
  videos.

Caddy:

```
display.example.com {
	reverse_proxy sidedisplay:4380
}
```

nginx:

```nginx
location / {
	proxy_pass http://sidedisplay:4380;
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_buffering off;          # live updates
	client_max_body_size 500m;    # uploads
}
```

To serve SideDisplay under a path (`https://example.com/displays/`), strip the
prefix in the proxy and send it in the `X-Forwarded-Prefix` header:

```nginx
location /displays/ {
	proxy_pass http://sidedisplay:4380/;
	proxy_set_header X-Forwarded-Prefix /displays;
	proxy_buffering off;
}
```

## Security in short

- The admin interface is protected by one password, stored hashed
  (Argon2id). Sessions last 30 days; changing the password signs every other
  browser out. Repeated wrong passwords are throttled.
- **Display addresses are public by design**: anyone who has an address can see
  that display, because the screens showing it cannot sign in. The id in the
  address is random; treat it like a share link. Do not put anything on a
  display that the room should not see.
- Displays only receive their own layouts and the data of the elements on
  them. The Home Assistant token never leaves the server.
- Uploaded files are served from `/media/` under random names, without signing
  in, since displays need them.
- If SideDisplay is reachable from the internet, put it behind HTTPS.

## Setting up a screen

Any device with a recent browser works: open the display's address full
screen. For a screen that runs unattended, we recommend
[DietPi](https://dietpi.com/) in its Chromium kiosk mode on a Raspberry Pi or
other small computer behind a TV or monitor, and
[FreeKiosk](https://github.com/RushB-fr/freekiosk) on an Android tablet.

[screens.md](screens.md) has step-by-step instructions for both, other
devices, and the per-display settings (rotation, daily reload, night dimming,
pixel shift) that help a screen run for months.

## Updating

Pull the new image and restart: `docker compose pull && docker compose up -d`.
The database is upgraded automatically at start. Open screens notice the new
version and reload themselves.

## Backup and restore

Stop the container and copy the `/data` volume, or copy it live: the database
uses SQLite's write-ahead log, so include `sidedisplay.db`, `sidedisplay.db-wal`
and `sidedisplay.db-shm` together with the `media` folder. The `cache` folder
can be left out; it is rebuilt as needed.

Single layouts can also be exported and imported as JSON files from the
Layouts page.
