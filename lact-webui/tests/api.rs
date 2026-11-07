//! End-to-end tests for the HTTP layer.
//!
//! A mock daemon speaks the real wire protocol (newline-delimited JSON, same `Response` envelope),
//! so the tests exercise the actual client, router, middleware and auth code paths without needing
//! GPU hardware. Payload shapes are taken from `lact-schema`.

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use lact_webui::{
    AppState, Daemon, Role, UserStore, WebConfig,
    api::router,
    config::DaemonEndpoint,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::atomic::{AtomicU32, Ordering}};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, net::UnixListener};
use tower::ServiceExt;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn socket_path() -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("lact-webui-test-{}-{id}.sock", std::process::id()))
}

/// Minimal but schema-valid responses for every request the web UI issues.
fn mock_response(request: &Value) -> Value {
    let command = request.get("command").and_then(Value::as_str).unwrap_or_default();

    match command {
        "ping" => json!({}),
        "system_info" => json!({
            "version": "0.10.1",
            "amdgpu_overdrive_enabled": null,
            "kernel_version": "6.12.0-test",
            "profile_rules_supported": true,
        }),
        "list_devices" => json!([
            { "id": "0000:03:00.0", "name": "AMD Radeon RX 7900 XTX", "device_type": "discrete" }
        ]),
        "device_info" => json!({
            "pci_info": {
                "device_pci_info": { "vendor_id": "0x1002", "model_id": "0x744c", "vendor": "AMD", "model": "Navi 31" },
                "subsystem_pci_info": { "vendor_id": "0x1da2", "model_id": "0xe471", "vendor": "Sapphire", "model": "RX 7900 XTX" }
            },
            "driver": "amdgpu",
            "vbios_version": "113-D7020100-102",
            "link_info": {
                "current_width": "16", "current_speed": "16.0 GT/s",
                "max_width": "16", "max_speed": "32.0 GT/s"
            },
            "drm_info": {
                "device_name": "AMD Radeon RX 7900 XTX (RADV NAVI31)",
                "pci_revision_id": 200,
                "family_name": "NAVI31",
                "asic_name": "Navi 31",
                "compute_units": 96,
                "vram_type": "GDDR6",
                "vram_bit_width": 384,
                "vram_vendor": "Samsung",
                "vram_clock_ratio": 1.0,
                "vram_max_bw": "960",
                "intel": {},
                "cache_info": { "Amd": [[{ "level": 2, "types": ["Data"], "size": 6291456, "cu_count": 96 }, 6]] },
                "amd_ip_info": [{ "ip_type": "MP0", "version_major": 13, "version_minor": 0, "count": 1, "queues": 2 }],
                "memory_info": { "resizeable_bar": true, "cpu_accessible_used": 0, "cpu_accessible_total": 25769803776i64 }
            },
            "flags": ["ConfigurableFanControl", "DumpableVBios", "HasPmfw"]
        }),
        "device_api_info" => json!({
            "vulkan_instances": [{
                "device_name": "AMD Radeon RX 7900 XTX (RADV NAVI31)",
                "api_version": "1.3.289",
                "driver": { "version": 1, "name": "radv", "info": "Mesa 24.3", "driver_version": "24.3.0" },
                "enabled_layers": [],
                "features": { "robustBufferAccess": true, "shaderInt64": true },
                "extensions": { "VK_KHR_swapchain": true, "VK_EXT_descriptor_indexing": true }
            }],
            "opencl_instances": []
        }),
        "device_stats" => json!({
            "fan": {
                "control_enabled": true,
                "control_mode": "curve",
                "pwm_current": 89,
                "speed_current": 1420,
                "speed_max": 3300,
                "speed_min": 0,
                "pwm_max": 255,
                "pwm_min": 0,
                "temperature_range": [20, 110],
                "temperature_key": "edge",
                "spindown_delay_ms": 0,
                "change_threshold": 0,
                "pmfw_info": {
                    "target_temp": { "current": 83, "allowed_range": [45, 110] },
                    "acoustic_limit": { "current": 3200, "allowed_range": [0, 4000] },
                    "zero_rpm_enable": true
                }
            },
            "clockspeed": { "gpu_clockspeed": 2450000000u64, "vram_clockspeed": 1218000000u64, "sensors": {} },
            "voltage": { "gpu": 950, "sensors": {} },
            "vram": { "total": 25769803776u64, "used": 4294967296u64, "gtt_total_usable": null, "gtt_used": null },
            "power": { "average": 312.4, "current": 318.0, "cap_current": 339.0, "cap_max": 400.0, "cap_min": 100.0, "cap_default": 339.0, "sensors": {} },
            "temps": {
                "edge": { "value": 61, "primary": true },
                "junction": { "value": 78, "primary": false },
                "mem": { "value": 66, "primary": false }
            },
            "busy_percent": 87,
            "performance_level": "auto",
            "active_power_states": null,
            "throttle_info": { "current": [] }
        }),
        "device_clocks_info" => json!({
            "max_sclk": 3000, "max_mclk": 1250, "max_voltage": 1050, "table": null
        }),
        "device_power_profile_modes" => json!({
            "modes": {
                "0": { "name": "BOOTUP_DEFAULT", "components": [] },
                "1": { "name": "3D_FULL_SCREEN", "components": [] },
                "6": { "name": "CUSTOM", "components": [] }
            },
            "value_names": ["MinActiveFreq", "MinActiveVolt"],
            "active": 0
        }),
        "get_power_states" => json!({
            "core": [{ "enabled": true, "value": 500, "min_value": null, "id": 0 }, { "enabled": true, "value": 2400, "min_value": null, "id": 1 }],
            "vram": [{ "enabled": true, "value": 96, "min_value": null, "id": 0 }]
        }),
        "displays_info" => json!({
            "displays": {
                "DP-1": {
                    "model": "LG HDR 4K", "manufacturer": "LG Electronics", "product_code": 30000,
                    "manufacture_date": { "year": 2021, "week": 34 },
                    "size": [600, 340], "connector_type": { "type": "DisplayPort" }, "connector_id": 1
                }
            }
        }),
        "process_list" => json!({
            "processes": {
                "4242": { "name": "game", "args": "./game --fullscreen", "memory_used": 2147483648u64, "types": ["graphics"], "util": { "graphics": 87 } }
            },
            "supported_util_types": ["graphics"]
        }),
        "get_gpu_config" => json!({
            "fan_control_enabled": true,
            "fan_control_settings": {
                "mode": "curve", "static_speed": 0.5, "temperature_key": "edge", "interval_ms": 1000,
                "curve": { "40": 0.3, "50": 0.35, "60": 0.5, "70": 0.75, "80": 1.0 },
                "spindown_delay_ms": 0, "change_threshold": 0, "auto_threshold": null
            },
            "pmfw_options": {},
            "nvidia_thermal_options": {},
            "power_mizer_mode": null,
            "power_cap": 340.0,
            "performance_level": "auto",
            "power_profile_mode_index": null,
            "power_states": {},
            "uma_carveout": null
        }),
        // The real daemon returns `apply_settings_timer` in SECONDS here (see handler.rs
        // `wait_config_confirm` -> `Duration::from_secs(apply_timer)`). The webui HTTP layer
        // scales it to milliseconds.
        "set_gpu_config" => json!(5),
        "set_fan_control" => json!(5),
        "list_profiles" => json!({
            "profiles": { "Default": null, "Gaming": null },
            "profile_hooks": {},
            "current_profile": "Default",
            "auto_switch": false,
            "watcher_state": null
        }),
        "get_profile" => json!({
            "name": "Gaming",
            "rule": null,
            "hooks": {},
            "gpus": {},
            "fan_control_enabled": false
        }),
        "vbios_dump" => json!([31, 139, 8, 0, 0, 0, 0, 0]),
        "generate_snapshot" => json!("/nonexistent/snapshot.tar.gz"),
        "confirm_pending_config" => json!(null),
        "reset_config" => json!(null),
        "enable_overdrive" | "disable_overdrive" => json!(null),
        other => json!({ "unhandled": other }),
    }
}

async fn spawn_mock_daemon(path: PathBuf) {
    let listener = UnixListener::bind(&path).expect("bind mock socket");

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };

            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                let mut line = String::new();

                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }

                    let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    let data = mock_response(&request);
                    let response = json!({ "status": "ok", "data": data });

                    if write.write_all(format!("{response}\n").as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    // Give the listener a moment to be ready.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

async fn test_app(auth: bool) -> (axum::Router, PathBuf) {
    test_app_with_roles(auth).await.0
}

/// Build the router with an account database. When `auth` is true it contains one admin
/// (`admin`/`correct horse`) and one operator (`viewer`/`correct horse`).
async fn test_app_with_roles(auth: bool) -> ((axum::Router, PathBuf), tempfile::TempDir) {
    let path = socket_path();
    spawn_mock_daemon(path.clone()).await;

    let dir = tempfile::tempdir().unwrap();
    let users_file = dir.path().join("users.yaml");
    let users = UserStore::load(&users_file).unwrap();

    if auth {
        users.create("admin", "correct horse", Role::Admin).await.unwrap();
        users.create("viewer", "correct horse", Role::Operator).await.unwrap();
    }

    let config = WebConfig {
        listen: "127.0.0.1:0".to_owned(),
        daemon: DaemonEndpoint::Socket { socket: path.clone() },
        allow_unauthenticated: !auth,
        auth: lact_webui::config::AuthConfig {
            users_file,
            ..Default::default()
        },
        ..Default::default()
    };

    let daemon = Daemon::spawn(config.daemon.clone());
    let state = AppState::new(config, daemon, users);
    ((router(state), path), dir)
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

fn post_login(username: &str, password: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        // `ConnectInfo` normally comes from the listener; tests inject it explicitly.
        .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            40000,
        ))))
        .body(Body::from(format!(
            r#"{{"username":"{username}","password":"{password}"}}"#
        )))
        .unwrap()
}

fn get_with_cookie(uri: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap()
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

#[tokio::test]
async fn serves_device_list_from_daemon() {
    let (app, path) = test_app(false).await;

    let response = app.clone().oneshot(get("/api/devices")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["id"], "0000:03:00.0");

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn proxies_stats_and_config() {
    let (app, path) = test_app(false).await;

    let stats = body_json(app.clone().oneshot(get("/api/devices/0000:03:00.0/stats")).await.unwrap()).await;
    assert_eq!(stats["power"]["cap_current"], 339.0);
    assert_eq!(stats["temps"]["edge"]["value"], 61);

    let config = body_json(app.clone().oneshot(get("/api/devices/0000:03:00.0/config")).await.unwrap()).await;
    assert_eq!(config["power_cap"], 340.0);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn renders_information_rows_server_side() {
    let (app, path) = test_app(false).await;

    let response = app
        .clone()
        .oneshot(get("/api/devices/0000:03:00.0/info-rows"))
        .await
        .unwrap();

    if response.status() != StatusCode::OK {
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        panic!("{status}: {}", String::from_utf8_lossy(&body));
    }

    let rows = body_json(response).await;
    let rows = rows.as_array().expect("array of rows");

    // Labels are localized by the server's locale, so assert on values and count only.
    assert!(rows.len() >= 5, "expected several rows, got {}", rows.len());
    assert!(rows
        .iter()
        .any(|row| row["value"].as_str().unwrap_or("").contains("RADV NAVI31")));
    assert!(rows
        .iter()
        .any(|row| row["value"].as_str().unwrap_or("") == "113-D7020100-102"));

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn serves_the_spa_shell() {
    let (app, path) = test_app(false).await;

    let response = app.clone().oneshot(get("/")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/html"
    );

    // Unknown non-API paths fall back to the shell so client-side routing works.
    let response = app.clone().oneshot(get("/thermals")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // But an unknown API path must 404 rather than return HTML.
    let response = app.clone().oneshot(get("/api/nope")).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn status_reports_daemon_connection() {
    let (app, path) = test_app(false).await;

    // First request primes the connection.
    let _ = app.clone().oneshot(get("/api/system")).await.unwrap();

    let body = body_json(app.clone().oneshot(get("/api/status")).await.unwrap()).await;
    assert_eq!(body["daemon_connected"], true);
    assert_eq!(body["auth_enabled"], false);
    assert_eq!(body["daemon"]["version"], "0.10.1");

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn hardware_endpoints_answer_without_gpu() {
    let (app, path) = test_app(false).await;

    let host = body_json(app.clone().oneshot(get("/api/hardware/system")).await.unwrap()).await;
    assert!(host["cpu"]["logical_cores"].as_u64().unwrap() >= 1);
    assert!(host["memory"]["total_kb"].as_u64().unwrap() > 0);

    let sensors = body_json(app.clone().oneshot(get("/api/hardware/sensors")).await.unwrap()).await;
    assert!(sensors["sensors"].is_array());

    let nvme = body_json(app.clone().oneshot(get("/api/hardware/nvme")).await.unwrap()).await;
    assert!(nvme["available"].is_boolean());

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn requires_login_when_auth_enabled() {
    let (app, path) = test_app(true).await;

    let response = app.clone().oneshot(get("/api/devices")).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // Wrong password is rejected.
    let response = app.clone().oneshot(post_login("admin", "wrong")).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // Correct password returns a session cookie.
    let response = app
        .clone()
        .oneshot(post_login("admin", "correct horse"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    assert!(cookie.starts_with("lact_session="));

    // The session opens the API.
    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/devices", &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn mutations_require_csrf_header() {
    let (app, path) = test_app(true).await;

    let login = app
        .clone()
        .oneshot(post_login("admin", "correct horse"))
        .await
        .unwrap();

    let cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    // Without the header: forbidden.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/devices/0000:03:00.0/config")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"power_cap":300.0}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // With the header: accepted and proxied to the daemon.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/devices/0000:03:00.0/config")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-lact-webui", "1")
                .body(Body::from(r#"{"power_cap":300.0}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(body["auto_revert_ms"], 5000);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn reports_daemon_errors_as_conflict() {
    let path = socket_path();
    let listener = UnixListener::bind(&path).unwrap();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        let _ = reader.read_line(&mut line).await;
        let _ = write
            .write_all(b"{\"status\":\"error\",\"data\":{\"description\":\"device is busy\",\"source\":null}}\n")
            .await;
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let dir = tempfile::tempdir().unwrap();
    let config = WebConfig {
        listen: "127.0.0.1:0".to_owned(),
        daemon: DaemonEndpoint::Socket { socket: path.clone() },
        allow_unauthenticated: true,
        auth: lact_webui::config::AuthConfig {
            users_file: dir.path().join("users.yaml"),
            ..Default::default()
        },
        ..Default::default()
    };

    let users = UserStore::load(&config.auth.users_file).unwrap();
    let state = AppState::new(config.clone(), Daemon::spawn(config.daemon.clone()), users);
    let app = router(state);

    let response = app.oneshot(get("/api/devices/x/stats")).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("device is busy"));

    let _ = std::fs::remove_file(path);
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

async fn login_cookie(app: &axum::Router, username: &str, password: &str) -> String {
    let response = app
        .clone()
        .oneshot(post_login(username, password))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK, "login for {username} failed");

    response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

fn request(method: &str, uri: &str, cookie: &str) -> Request<Body> {
    request_with_body(method, uri, cookie, "")
}

fn request_with_body(method: &str, uri: &str, cookie: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie)
        .header("x-lact-webui", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap()
}

#[tokio::test]
async fn operator_can_monitor_but_not_change_anything() {
    let ((app, path), _dir) = test_app_with_roles(true).await;
    let cookie = login_cookie(&app, "viewer", "correct horse").await;

    // Monitoring is allowed.
    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/devices/0000:03:00.0/stats", &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/status", &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Every mutating path is refused, even with a valid session and CSRF header.
    for (method, uri) in [
        ("PUT", "/api/devices/0000:03:00.0/config"),
        ("POST", "/api/devices/0000:03:00.0/fan"),
        ("POST", "/api/devices/0000:03:00.0/power-cap"),
        ("POST", "/api/overdrive/enable"),
        ("POST", "/api/snapshot"),
        ("POST", "/api/users"),
        ("DELETE", "/api/users/viewer"),
    ] {
        let response = app.clone().oneshot(request(method, uri, &cookie)).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{method} {uri} should be forbidden for an operator"
        );
    }

    // ...but the account list is not readable either.
    let response = app.clone().oneshot(get_with_cookie("/api/users", &cookie)).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn admin_can_manage_accounts() {
    let ((app, path), _dir) = test_app_with_roles(true).await;
    let cookie = login_cookie(&app, "admin", "correct horse").await;

    // Create an operator account.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/users")
                .header(header::COOKIE, &cookie)
                .header("x-lact-webui", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"username":"tech","password":"workshop42","role":"operator"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // The new account can log in and is read-only.
    let tech_cookie = login_cookie(&app, "tech", "workshop42").await;
    let response = app
        .clone()
        .oneshot(request("POST", "/api/devices/0000:03:00.0/fan", &tech_cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // Promote it to admin, then it may write.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/users/tech")
                .header(header::COOKIE, &cookie)
                .header("x-lact-webui", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"role":"admin"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(request_with_body(
            "POST",
            "/api/devices/0000:03:00.0/fan",
            &tech_cookie,
            r#"{"enabled":false}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "promotion must take effect without a new login"
    );

    // The list shows both accounts plus the seeded ones.
    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/users", &cookie))
        .await
        .unwrap();
    let body = body_json(response).await;
    let names: Vec<&str> = body["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|user| user["username"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"admin") && names.contains(&"tech") && names.contains(&"viewer"));

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn cannot_remove_the_last_admin() {
    let ((app, path), _dir) = test_app_with_roles(true).await;
    let cookie = login_cookie(&app, "admin", "correct horse").await;

    // Demoting the only admin is refused by the store and surfaces as 400.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/users/admin")
                .header(header::COOKIE, &cookie)
                .header("x-lact-webui", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"role":"operator"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = app
        .clone()
        .oneshot(request("DELETE", "/api/users/admin", &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn deleting_an_account_revokes_its_session_immediately() {
    let ((app, path), _dir) = test_app_with_roles(true).await;
    let admin_cookie = login_cookie(&app, "admin", "correct horse").await;
    let viewer_cookie = login_cookie(&app, "viewer", "correct horse").await;

    // The operator session works.
    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/status", &viewer_cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(request("DELETE", "/api/users/viewer", &admin_cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // The old cookie must stop working without waiting for the session timeout.
    let response = app
        .clone()
        .oneshot(get_with_cookie("/api/status", &viewer_cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let _ = std::fs::remove_file(path);
}
