# LACT WebUI

`lact-webui` is the browser front-end for LACT. It replaces the GTK4 desktop application
(`lact-gui`, removed in this fork) so a **headless** machine can be configured from any browser on
the network.

It is a small Rust binary that:

1. connects to the existing `lactd` daemon over its unix socket (or TCP, if you enabled it),
2. exposes an authenticated HTTP/JSON API plus a websocket statistics stream,
3. serves a single-page UI that is embedded in the binary (no external files, no node runtime).

The daemon keeps doing all hardware work. Nothing about GPU control is reimplemented — the web UI
is a typed client of the exact same protocol the GTK app used, built against `lact-schema`, so it
cannot drift from the daemon's data model.

---

## Architecture

```
 lactd (root, /run/lactd.sock)  ──newline-delimited JSON──►  lact-webui (axum)  ──HTTP/WS──►  browser
   GPU control, polkit, config        typed request/response      auth + REST + SPA             any machine
```

Why the unix socket and not the daemon's `tcp_listen_address`?

- The socket is authenticated by the kernel: `lactd` reads peer credentials and authorizes writes
  through polkit. A TCP connection carries no identity, so LACT documents it as root-equivalent.
- Running `lact-webui` as root on the same host gives it exactly the privileges it needs and
  nothing is exposed beyond the port you choose.
- You get HTTP auth, TLS termination (reverse proxy), rate limiting and an audit trail at one place.

## Installation

### From source

```sh
cargo build -p lact-webui --release
sudo install -Dm755 target/release/lact-webui /usr/bin/lact-webui
sudo install -Dm644 res/lact-webui.service /lib/systemd/system/lact-webui.service
```

`make build-webui install` does the same (with `PREFIX=/usr`).

### Configuration

```sh
# 1. pick a password and hash it
lact-webui --hash-password 'correct horse battery staple'
# → $argon2id$v=19$m=19456,t=2,p=1$...

# 2. write the config
sudo tee /etc/lact/webui.yaml >/dev/null <<'EOF'
listen: 0.0.0.0:12800
auth:
  password_hash: "$argon2id$v=19$m=19456,t=2,p=1$..."
session_timeout_hours: 12
daemon:
  socket: /run/lactd.sock
EOF

# 3. run
sudo systemctl enable --now lactd lact-webui
```

Open `http://<host>:12800`.

`lact-webui --print-default-config` prints every option with its default.

### Full configuration reference

| Key | Default | Meaning |
|-----|---------|---------|
| `listen` | `0.0.0.0:12800` | Address to bind. Use `127.0.0.1:12800` behind a reverse proxy. |
| `daemon.socket` | `/run/lactd.sock` | Path to the daemon's unix socket (root's default). |
| `daemon.tcp` | — | Alternative: `{ tcp: "127.0.0.1:12853" }` to use LACT's TCP listener. |
| `auth.password_hash` | — | Argon2id hash. **Required** when listening on a non-loopback address. |
| `auth.max_attempts` | `5` | Failed logins per IP before the client is blocked. |
| `auth.attempt_window_secs` | `60` | Window for the attempt counter. |
| `session_timeout_hours` | `12` | Idle session lifetime. Sessions live in memory only. |
| `allow_unauthenticated` | `false` | Disable auth entirely. Only with a reverse proxy that authenticates users. |
| `refresh_interval_ms` | `1000` | Default stats poll interval for the websocket. |
| `device_allowlist` | `[]` | Restrict the instance to specific GPU ids (empty = all). |
| `log` | `info,tower_http=warn` | `tracing` filter, overridable with `RUST_LOG`. |

The server **refuses to start** on a non-loopback address without a password unless
`allow_unauthenticated: true` is set explicitly.

## Security model

- **Password auth** with Argon2id hashes; the plaintext password is never stored.
- **Sessions**: 256-bit random tokens, `HttpOnly`, `SameSite=Strict`, `Secure` when
  `X-Forwarded-Proto: https` is present. Held in memory, so a restart logs everyone out.
- **CSRF**: mutating requests must carry `X-LACT-WebUI: 1`. Browsers cannot set custom headers
  cross-origin without a CORS preflight, which this server never grants.
- **Rate limiting**: per-IP failed-login throttling (default 5 per minute).
- **No shell**: the web UI never builds shell commands from requests. Every action is a typed
  message to the daemon. The one place the UI does run binaries is the read-only hardware page
  (`nvme`, `systemctl`), with fixed arguments.
- **systemd hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`,
  `DevicePolicy=closed`, restricted address families — see `res/lact-webui.service`.

### TLS

Terminate TLS at a reverse proxy; the UI does not implement it. Example Caddy:

```
lact.example.lan {
    reverse_proxy 127.0.0.1:12800
}
```

Caddy needs websocket support, which `reverse_proxy` provides automatically (HTTP/1.1 upgrade).
If you use nginx, add:

```nginx
location / {
    proxy_pass http://127.0.0.1:12800;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Features

Everything the GTK app exposed, plus host hardware management:

| Page | Contents |
|------|----------|
| Information | Live tiles (temp, power, clocks, fan, VRAM, usage) + all `DeviceInfo` rows, caches, IP blocks, throttling |
| Overclocking | Power limit, performance level, PowerMizer, core/memory min-max clocks, voltage offset, per-pstate offsets, AMD power profile modes + heuristics, DPM power states, detach/reattach |
| Thermals | Automatic / curve / static fan control, draggable fan curve, temperature sensor selection, spindown delay, change threshold, AMD PMFW limits, NVIDIA auto threshold |
| Software | Driver, VBIOS + dump, Vulkan features/extensions, OpenCL, PCIe link |
| Displays | Connector, manufacturer, model, physical size, manufacture date |
| **System** (new) | Host CPU/memory/load/uptime, all hwmon sensors, NVMe SMART health, block devices, PCI inventory, service state |
| Historical charts | 7 live series, 10 minute window, CSV export |

Everything is applied atomically through the daemon and guarded by the same "keep these settings?"
confirmation countdown as upstream: if you do not confirm (or cannot, because the overclock killed
the display), the daemon reverts.

## HTTP API

All endpoints live under `/api`. Reads are `GET`, writes are `POST`/`PUT`/`DELETE` and require the
`X-LACT-WebUI: 1` header plus a session cookie.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | `{password}` → sets session cookie |
| POST | `/api/auth/logout` | clears the session |
| GET | `/api/auth/session` | `{authenticated, auth_required, version}` |
| GET | `/api/status` | web UI + daemon status |
| GET | `/api/devices` | device list |
| GET | `/api/devices/{id}/info?api_info=true` | `DeviceInfo` |
| GET | `/api/devices/{id}/info-rows` | server-rendered information rows |
| GET | `/api/devices/{id}/stats` | `DeviceStats` |
| GET | `/api/devices/{id}/clocks` | `ClocksInfo` |
| GET | `/api/devices/{id}/power-profile-modes` | AMD power profile table |
| GET | `/api/devices/{id}/power-states` | DPM states |
| GET | `/api/devices/{id}/displays` | displays |
| GET | `/api/devices/{id}/processes` | processes using the GPU |
| GET/PUT | `/api/devices/{id}/config` | read/apply a full `GpuConfig` |
| POST | `/api/devices/{id}/config/confirm` | `{command: "confirm"\|"revert"}` |
| POST | `/api/devices/{id}/fan` | fan control (`FanOptions`) |
| POST | `/api/devices/{id}/power-cap` | `{cap}` |
| POST | `/api/devices/{id}/performance-level` | `{level}` |
| POST | `/api/devices/{id}/clocks` | batch clock commands |
| POST | `/api/devices/{id}/power-profile-mode` | `{index, custom_heuristics}` |
| POST | `/api/devices/{id}/power-states` | `{kind, states}` |
| POST | `/api/devices/{id}/vbios` | VBIOS download |
| POST | `/api/devices/{id}/detach` \| `reattach` | driver unbind/rebind |
| GET/POST | `/api/profiles` | list/create profiles |
| GET/DELETE | `/api/profiles/{name}` | read/delete |
| POST | `/api/profiles/{name}/activate` \| `rename` \| `move` | manage |
| GET/PUT | `/api/profiles/{name}/rule` | activation rule + hooks |
| POST | `/api/overdrive/enable` \| `disable` | AMD overdrive |
| POST | `/api/snapshot` | debug snapshot tarball |
| GET | `/api/hardware/system` \| `sensors` \| `nvme` \| `drives` \| `pci` \| `services` | host hardware |
| GET | `/api/ws` | websocket: `{type:"stats"\|"daemon"\|"hello"\|"error"}` |

Errors are JSON: `{"error": "...", "status": 409}`. Daemon-side failures surface as `409 Conflict`
with the daemon's own message; an unreachable daemon is `502 Bad Gateway`.

## Development

```sh
cargo test -p lact-webui          # 15 tests: config, auth, protocol parsing, HTTP end-to-end
cargo run -p lact-webui -- --listen 127.0.0.1:12800 --allow-unauthenticated
```

The front-end lives in `web/` as plain ES modules — no bundler, no `node_modules`, no build step.
Edit a file, reload the browser (run `cargo build` first, the assets are embedded at compile time).

Layout:

```
lact-webui/src/
  config.rs      YAML config, password hashing/verification
  auth.rs        sessions, cookie parsing, login rate limiting
  daemon.rs      protocol client: one owning task, channel-based, auto-reconnect
  server.rs      bootstrap, tracing, graceful shutdown
  api/
    mod.rs       router, auth middleware, status
    gpu.rs       device endpoints (reads proxy the daemon, writes are typed)
    profiles.rs  profile endpoints
    hardware.rs  NVMe/SMART, hwmon, host, PCI (new)
    files.rs     embedded assets, snapshot/VBIOS downloads
    ws.rs        live statistics stream
web/
  index.html     shell, icon sprite
  css/app.css    libadwaita-like design tokens and components
  js/app.js      bootstrap, routing, apply/revert, websocket
  js/pages/*.js  one module per page
  js/fancurve.js draggable SVG curve editor
```

## Differences from upstream LACT

- `lact-gui` (GTK4) is removed; `lact` with no arguments now serves the web UI instead of opening a
  window. `lact daemon` and `lact cli` are unchanged.
- New `System` page and `/api/hardware/*` endpoints (NVMe SMART, hwmon, PCI, host load).
- `lact-webui` binary + `lact-webui.service`.
- The web UI stores theme and refresh interval per browser; everything else stays server-side.

The daemon, the CLI, the config format and `/etc/lact/config.yaml` are untouched, so this fork is
compatible with an existing LACT installation — stop the GTK app and enable `lact-webui` instead.

## License

MIT, same as upstream. LACT is Copyright (c) Ilya Zlobintsev.
