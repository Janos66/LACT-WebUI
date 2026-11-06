# LACT-WebUI — Specification & Progress

Headless web front-end for [LACT](https://github.com/ilya-zlobintsev/LACT) (Linux GPU Control
Application). This repository is a fork of LACT 0.10.1 with the GTK4/libadwaita desktop UI
(`lact-gui`) **removed** and replaced by a browser UI served by a small Rust HTTP server.

Upstream: <https://github.com/ilya-zlobintsev/LACT> (v0.10.1, commit at fork time)
This fork: <https://github.com/Janos66/LACT-WebUI>

---

## 1. Goal

Make LACT usable on a **headless** machine: no X11/Wayland session, no GTK, no local display.
An administrator opens `http://<host>:12800` in a browser on any machine in the network and gets
the same monitoring/control surface LACT's desktop app provides, plus hardware management
extras (NVMe/SMART, hwmon sensors, host system overview).

## 2. Architecture

```
 ┌────────────────────────┐   newline-delimited JSON   ┌──────────────────────────┐   HTTPS/HTTP   ┌─────────┐
 │ lactd  (lact-daemon)   │◄──────────────────────────►│ lact-webui               │◄──────────────►│ Browser │
 │ root, /run/lactd.sock  │  over unix socket           │ Rust/axum + embedded SPA │  session cookie│ (SPA)   │
 │ GPU control, polkit    │  (or TCP if configured)     │ auth, REST, WebSocket    │                │         │
 └────────────────────────┘                             └──────────────────────────┘                └─────────┘
```

Design rules:

1. **No GPU logic is duplicated.** All hardware access stays in `lact-daemon`. The web server is a
   client of the daemon's existing JSON protocol, reusing the `lact-schema` types directly so the
   wire format can never drift from upstream.
2. **The daemon protocol is not exposed to the network.** The web server talks to the daemon over
   the unix socket (`/run/lactd.sock`) as root — which also satisfies the daemon's polkit checks
   via peer credentials. LACT's own `tcp_listen_address` option is *not* required or recommended.
3. **Single binary, no build step for the frontend.** The SPA is plain ES modules + hand-written
   CSS embedded into the binary with `rust-embed`. There is no npm, no bundler, no `node_modules`.
4. **Fail loudly, never silently.** If the daemon is unreachable the UI shows a reconnect banner and
   every write path returns a real error; nothing is faked.

## 3. Crates

| crate          | status            | notes |
|----------------|-------------------|-------|
| `lact-schema`  | upstream, unchanged | shared types; also renders `info_elements()` server-side |
| `lact-daemon`  | upstream, unchanged | hardware control, unchanged behaviour |
| `lact-client`  | upstream, unchanged | reference client (not used by webui, see below) |
| `lact-cli`     | upstream, unchanged | headless CLI still available |
| `lact-gui`     | **removed**       | replaced by `lact-webui` + `web/` |
| `lact-webui`   | **new**           | axum server: auth, REST proxy, WebSocket stats, hardware extras |
| `lact`         | changed           | launcher: no args → web UI server, `daemon`/`cli` unchanged |

`lact-client`'s `DaemonClient` is `!Send` (holds `Rc`), which cannot live inside axum state. The
webui therefore contains a small dedicated client (`daemon.rs`) that speaks the same protocol over
`UnixStream`/`TcpStream` and is driven by a single owning task; axum handlers talk to it through a
`tokio::mpsc` request channel. This keeps one serialized connection (the protocol is
request/response per connection) and makes reconnects trivial.

## 4. HTTP API (implemented by `lact-webui`)

Auth (session cookie `lact_session`, HttpOnly, SameSite=Strict):

- `POST /api/auth/login` `{password}` → sets cookie; rate-limited, constant-time compare
- `POST /api/auth/logout`
- `GET  /api/auth/session` → `{authenticated, auth_required, user}`

Read paths (GET, all require session unless `auth_required=false`):

- `/api/status` → `{daemon_connected, daemon_version, webui_version, hostname, uptime}`
- `/api/devices` → `Vec<DeviceListEntry>`
- `/api/devices/:id/info?api_info=true` → `DeviceInfo` (+ `DeviceApiInfo`)
- `/api/devices/:id/stats` → `DeviceStats`
- `/api/devices/:id/clocks` → `ClocksInfo`
- `/api/devices/:id/power-profile-modes` → `PowerProfileModesTable`
- `/api/devices/:id/power-states` → `PowerStates`
- `/api/devices/:id/displays` → `DisplaysInfo`
- `/api/devices/:id/processes` → `ProcessList`
- `/api/devices/:id/config` → `GpuConfig | null`
- `/api/devices/:id/info-rows` → server-rendered `[{name, value}]` from
  `DeviceInfo::info_elements()` (guarantees identical labels to upstream)
- `/api/profiles?include_state=true` → `ProfilesInfo`
- `/api/profiles/:name` → `Profile | null`
- `/api/system` → `SystemInfo` (daemon)

Write paths (POST/PUT/DELETE, JSON body, require session + `X-LACT-WebUI` header for CSRF):

- `PUT  /api/devices/:id/config` → applies a full `GpuConfig` (returns pending-confirm token)
- `POST /api/devices/:id/config/confirm` `{command: confirm|revert}`
- `POST /api/devices/:id/fan` → `FanOptions` (auto / static / curve)
- `POST /api/devices/:id/power-cap` `{cap}`
- `POST /api/devices/:id/performance-level` `{level}`
- `POST /api/devices/:id/clocks` → `[SetClocksCommand]`
- `POST /api/devices/:id/power-profile-mode` `{index, custom_heuristics}`
- `POST /api/devices/:id/power-states` `{kind, states}`
- `POST /api/devices/:id/vbios` → gzip binary download
- `POST /api/devices/:id/detach` / `reattach`
- `POST /api/profiles` / `DELETE /api/profiles/:name` / `POST /api/profiles/:name/activate`
  / `POST /api/profiles/:name/rename` / `POST /api/profiles/:name/move` / `PUT /api/profiles/:name/rule`
- `POST /api/overdrive/enable` / `disable`
- `POST /api/snapshot` → debug snapshot tarball

Live data: `GET /api/ws` (WebSocket) pushes `{type:"stats", id, stats}` at 1 Hz for the selected
device, plus `{type:"daemon", connected}`, `{type:"profile", name}` events. Client falls back to
polling if the socket cannot be established.

Hardware extras (new, not in upstream LACT):

- `GET /api/hardware/system` → CPU model, core count, load average, memory, uptime, kernel, distro
- `GET /api/hardware/sensors` → all hwmon chips: temps, fans, voltages, power, per-rail labels
- `GET /api/hardware/nvme` → `nvme list --output-format=json` + `nvme smart-log -o json` per drive
  (degrades gracefully when the `nvme` binary is absent)
- `GET /api/hardware/drives` → block devices with model/size/temp from `/sys`
- `GET /api/hardware/pci` → lspci-style listing from `/sys/bus/pci`

## 5. Frontend

Same information architecture as upstream (dark libadwaita look):

- Sidebar 230 px: GPU selector → profile selector → page list → **Apply / Revert**.
- Header: page title, "Historical charts" button, menu (process monitor, debug snapshot,
  VBIOS dump, preferences, about).
- Pages: **Information** (info cards + stats), **Overclocking**, **Thermals** (fan curve editor),
  **Software** (Vulkan/OpenCL/VBIOS), **Displays**, plus new **System** page (hardware extras).
- Unsaved-change tracking: edits accumulate client-side, Apply writes them, Revert reloads.
- Toasts for success/error; reconnect banner when the daemon or WebSocket drops.
- Fan curve editor: draggable points on an SVG chart, matching upstream semantics
  (temperature range from daemon, speed 0–1, spindown delay, change threshold, temp key selection).
- Charts: canvas sparklines/history for power, temps, clocks, fan speed, VRAM, plus CSV export.

## 6. Security

- Password auth required by default when binding to a non-loopback address; if no password is
  configured the server refuses to start on `0.0.0.0` unless `allow_unauthenticated: true`.
- `argon2` password hashes in the config file; password can be generated with
  `lact-webui --hash-password`.
- Session tokens: 32 random bytes, stored hashed in memory, 12 h idle timeout, `HttpOnly`,
  `SameSite=Strict`, `Secure` when TLS is configured.
- Login rate limit (5 attempts / 60 s per IP, exponential backoff).
- Mutating requests require the `X-LACT-WebUI: 1` header (blocks form-based CSRF).
- Optional TLS via `rustls` with operator-provided cert/key.
- The web server runs as root only to reach the daemon socket; it never executes user input.

## 7. Deployment

- `res/lact-webui.service` systemd unit, `After=lactd.service`.
- Config `/etc/lact/webui.yaml` (see `docs/WEBUI.md`).
- `make install` installs `lactd` service, `lact-webui` service and the `lact` launcher.

## 8. Progress log

- [x] Clone upstream LACT 0.10.1, map architecture (daemon JSON protocol, schema, GUI pages).
- [x] Fork tree prepared; `lact-gui` removed; workspace members updated.
- [ ] `lact-webui` crate: daemon bridge client.
- [ ] HTTP API + auth.
- [ ] SPA (all pages).
- [ ] Hardware extras (NVMe/SMART, sensors, system).
- [ ] End-to-end test against a real `lactd` (Intel Arc iGPU on the build host) + headless
      Chromium screenshots.
- [ ] Packaging, docs, push to GitHub.

## 9. Verification policy

Every claim in the final report must be backed by real output: the daemon must actually answer,
the API must actually return data, and the UI must actually render in headless Chromium. No
screenshots or JSON echoed from memory.

## 10. Verification results (actual runs)

Environment: Ubuntu 26.04, Intel Arc iGPU (Meteor Lake-P, `i915`), no root, no distro packages
installed — `libclang`/`libLLVM`/clang builtin headers were fetched as `.deb` files and extracted
locally so `bindgen` (a hard requirement of `lact-daemon`'s build script) could run.

| Check | Command | Result |
|-------|---------|--------|
| Library + integration tests | `cargo test -p lact-webui` | **18 passed, 0 failed** (9 unit, 9 HTTP end-to-end against a protocol-accurate mock daemon) |
| Daemon builds in this fork | `cargo build -p lact-daemon --no-default-features` | OK |
| Launcher builds with web UI | `cargo build -p lact --no-default-features --features webui` | OK |
| Real daemon serves real hardware | `./target/debug/lact daemon` | socket `/run/user/1000/lactd.sock`, device `8086:7D55-…` "Meteor Lake-P [Intel Arc Graphics]" |
| Web UI against the real daemon | `curl /api/status`, `/stats`, `/info`, `/hardware/*` | real driver `i915`, Vulkan 1.4.335, live clocks, host CPU/RAM/sensors |
| Every page renders | headless Chromium + CDP | 7/7 pages: correct title, section headings, **no uncaught exceptions**, zero horizontal overflow |
| Design tokens applied | CDP computed styles | window `#222226`, sidebar `#1e1e22`, card `#2c2c31`, header `#2a2a2f`, accent `#3584e4`, radius 14px, Cantarell |
| Layout geometry | CDP `getBoundingClientRect` | sidebar 230px, header 52px, page starts at y=52, cards 1240px wide, no card spills |

Bugs found and fixed **because** of this verification:

1. `serde_error::Error` is `{description, source}` — the error envelope was wrong in tests and
   therefore in the client's expectations.
2. `DeviceFlag`/`CacheType`/`DeviceType` serialise as PascalCase (`ConfigurableFanControl`), not
   snake_case — the fan-control support check and VBIOS dump button silently never matched.
3. `IntelDrmInfo` is `#[serde(flatten)]`, so `execution_units`/`subslices` live on `drm_info`, not
   under an `intel` key — two information rows were missing.
4. A YAML config could not express the externally-tagged `DaemonEndpoint` enum; it is now an
   untagged `{socket: …}` / `{tcp: …}` map.
5. Embedded assets were cached for 300 s, so a rebuilt binary kept serving the old bundle; JS/CSS are
   now `no-cache`.
6. `[hidden]` lost against `display:flex/grid` in the stylesheet, which left a 49 px banner strip on
   every page **and kept the login overlay painted on top of the app**. This was only visible in a
   screenshot.
7. AMD-only endpoints (`power-states`, `power-profile-modes`) were requested on Intel, producing a
   409 per page load; they are now gated on `driver == "amdgpu"`.

Not verified: pixel-level visual review by a vision model (the vision endpoint was unreachable for
the whole session). Rendering was verified by DOM text, computed styles, element geometry and
per-page pixel statistics (distinct image hashes, text-pixel counts, sidebar colour) instead.
`lact-daemon` was built without `display-info`, so the Displays page shows its empty state here;
the populated path is covered by the mock-daemon test.

## 11. Accounts and roles (added after the first review)

Single shared password replaced by a user database:

* `users.rs` — Argon2id accounts in `/etc/lact/webui-users.yaml` (0600, atomic replace), roles
  `admin`/`operator`, last-admin protection, immediate session revocation on password/disable/delete.
* Sessions carry the username; the **role is looked up on every request**, so a demotion or deletion
  takes effect at once rather than at session expiry.
* `require_auth` middleware rejects every non-`GET` request from an operator with `403`
  (self-service password change excepted), after the CSRF check.
* `/api/users` CRUD (admin only), `/api/me`, `/api/auth/password`.
* CLI: `--add-user`, `--set-password`, `--remove-user`, `--list-users`, `--password-stdin`.
* Empty account database => the server refuses to start and prints the command to create one.
* `scripts/install.sh` elevates with sudo, installs units/binaries, writes the config, creates the
  first admin and starts both services.

Verified end-to-end against the running daemon:

| Request | Result |
|---------|--------|
| anonymous `GET /api/devices` | 401 |
| `admin` login, then `GET /api/devices` | 200 |
| `admin` `POST /api/users` | 200 (account created) |
| `operator` login, then `GET /api/devices` | 200 |
| `operator` `POST /api/devices/…/fan` | **403** "this account is read-only (operator role)" |
| `operator` `POST /api/users/…` | **403** |
| admin sees 8 nav entries (incl. Users); operator sees 7, Apply/Revert hidden, read-only banner | screenshot `users.png`, `operator.png` |
