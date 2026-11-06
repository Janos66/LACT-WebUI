//! HTTP surface of the web UI.

pub mod files;
pub mod gpu;
pub mod hardware;
pub mod profiles;
pub mod users;
pub mod ws;

use crate::{
    auth::{LoginCheck, LoginLimiter, SESSION_COOKIE, SessionStore, cookie_value},
    config::WebConfig,
    daemon::Daemon,
    error::{ApiError, ApiResult},
    users::{Role, UserStore},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Extension, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use lact_schema::Request as DaemonRequest;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Instant,
};
use tower_http::compression::CompressionLayer;
use tracing::warn;

/// Name of the header that mutating requests must carry. Together with the `SameSite=Strict`
/// session cookie this blocks classic form-based CSRF, which cannot set custom headers.
pub const CSRF_HEADER: &str = "x-lact-webui";

#[derive(Clone)]
pub struct AppState {
    pub daemon: Daemon,
    pub sessions: SessionStore,
    pub limiter: Arc<LoginLimiter>,
    pub config: Arc<WebConfig>,
    pub users: Arc<UserStore>,
    pub started: Instant,
    pub version: &'static str,
}

impl AppState {
    pub fn new(config: WebConfig, daemon: Daemon, users: UserStore) -> Self {
        let limiter = Arc::new(LoginLimiter::new(&config.auth));
        let sessions = SessionStore::new(config.session_timeout_hours);

        Self {
            daemon,
            sessions,
            limiter,
            config: Arc::new(config),
            users: Arc::new(users),
            started: Instant::now(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    pub fn auth_enabled(&self) -> bool {
        self.config.auth_enabled()
    }

    /// Whether an account database exists. With no users the server refuses to start (see
    /// `server::prepare`), so this is only observable in tests and in opt-out deployments.
    pub async fn has_users(&self) -> bool {
        !self.users.is_empty().await
    }
}

/// The authenticated caller, injected by [`require_auth`].
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub username: String,
    pub role: Role,
}

pub fn router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/session", get(session_info))
        .route("/api/auth/logout", post(logout))
        .with_state(state.clone());

    let protected = Router::new()
        .route("/api/status", get(status))
        .route("/api/system", get(system_info))
        .route("/api/me", get(me))
        .route("/api/auth/password", post(change_password))
        .route("/api/users", get(users::list).post(users::create))
        .route("/api/users/{name}", put(users::update).delete(users::delete))
        .route("/api/devices", get(gpu::list_devices))
        .route("/api/devices/{id}/info", get(gpu::device_info))
        .route("/api/devices/{id}/info-rows", get(gpu::info_rows))
        .route("/api/devices/{id}/api-info", get(gpu::api_info))
        .route("/api/devices/{id}/stats", get(gpu::device_stats))
        .route("/api/devices/{id}/clocks", get(gpu::clocks_info))
        .route("/api/devices/{id}/power-profile-modes", get(gpu::power_profile_modes))
        .route("/api/devices/{id}/power-states", get(gpu::get_power_states))
        .route("/api/devices/{id}/displays", get(gpu::displays))
        .route("/api/devices/{id}/processes", get(gpu::processes))
        .route("/api/devices/{id}/config", get(gpu::get_config).put(gpu::set_config))
        .route("/api/devices/{id}/config/confirm", post(gpu::confirm_config))
        .route("/api/devices/{id}/fan", post(gpu::set_fan))
        .route("/api/devices/{id}/power-cap", post(gpu::set_power_cap))
        .route("/api/devices/{id}/performance-level", post(gpu::set_performance_level))
        .route("/api/devices/{id}/clocks", post(gpu::set_clocks))
        .route("/api/devices/{id}/power-profile-mode", post(gpu::set_power_profile_mode))
        .route("/api/devices/{id}/power-states", post(gpu::set_power_states))
        .route("/api/devices/{id}/vbios", post(gpu::dump_vbios))
        .route("/api/devices/{id}/detach", post(gpu::detach))
        .route("/api/devices/{id}/reattach", post(gpu::reattach))
        .route("/api/profiles", get(profiles::list).post(profiles::create))
        .route("/api/profiles/{name}", get(profiles::get).delete(profiles::delete))
        .route("/api/profiles/{name}/activate", post(profiles::activate))
        .route("/api/profiles/{name}/rename", post(profiles::rename))
        .route("/api/profiles/{name}/move", post(profiles::move_profile))
        .route("/api/profiles/{name}/rule", get(profiles::get_rule).put(profiles::set_rule))
        .route("/api/profiles/rule/evaluate", post(profiles::evaluate_rule))
        .route("/api/overdrive/enable", post(profiles::enable_overdrive))
        .route("/api/overdrive/disable", post(profiles::disable_overdrive))
        .route("/api/snapshot", post(files::snapshot))
        .route("/api/config/reset", post(profiles::reset_config))
        .route("/api/hardware/system", get(hardware::system))
        .route("/api/hardware/sensors", get(hardware::sensors))
        .route("/api/hardware/nvme", get(hardware::nvme))
        .route("/api/hardware/drives", get(hardware::drives))
        .route("/api/hardware/pci", get(hardware::pci))
        .route("/api/hardware/services", get(hardware::services))
        .route("/api/ws", get(ws::handler))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state.clone());

    Router::new()
        .merge(public)
        .merge(protected)
        .fallback(files::serve_static)
        .layer(CompressionLayer::new())
        .with_state(state)
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    if !state.auth_enabled() {
        return Err(ApiError::bad_request("authentication is disabled on this instance"));
    }

    let ip = client_ip(&headers, addr);

    if let LoginCheck::Blocked { retry_after } = state.limiter.check(ip).await {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            format!(
                "too many failed attempts, retry in {} seconds",
                retry_after.as_secs().max(1)
            ),
        ));
    }

    let username = body.username.trim().to_owned();

    let role = state.users.authenticate(&username, &body.password).await;

    let Some(role) = role else {
        state.limiter.record_failure(ip).await;
        // Deliberately identical for "no such user" and "wrong password".
        warn!("failed login attempt for '{username}' from {ip}");
        return Err(ApiError::unauthorized("wrong username or password"));
    };

    state.limiter.record_success(ip).await;
    let token = state.sessions.create(&username, ip.to_string()).await;

    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|proto| proto.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    let cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        state.sessions.timeout().as_secs(),
        if secure { "; Secure" } else { "" }
    );

    let mut response = Json(json!({
        "ok": true,
        "username": username,
        "role": role,
    }))
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|err| ApiError::internal(err.to_string()))?,
    );
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = session_token(&headers) {
        state.sessions.remove(token).await;
    }

    let cookie = format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    let mut response = Json(json!({"ok": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|err| ApiError::internal(err.to_string()))?,
    );
    Ok(response)
}

async fn session_info(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut username = None;
    let mut role = None;

    if !state.auth_enabled() {
        username = Some("anonymous".to_owned());
        role = Some(Role::Admin);
    } else if let Some(token) = session_token(&headers) {
        if let Some(session) = state.sessions.validate(token).await {
            if let Some(current) = state.users.role_of(&session.username).await {
                username = Some(session.username);
                role = Some(current);
            }
        }
    }

    Ok(Json(json!({
        "authenticated": username.is_some(),
        "auth_required": state.auth_enabled(),
        "username": username,
        "role": role,
        "version": state.version,
        "user_count": state.users.len().await,
    })))
}

async fn me(Extension(auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!({
        "username": auth.username,
        "role": auth.role,
    }))
}

#[derive(Deserialize)]
pub struct PasswordBody {
    pub current_password: String,
    pub new_password: String,
}

/// Change your own password. Allowed for both roles, and it invalidates every other session.
async fn change_password(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> ApiResult<Response> {
    if state.users.authenticate(&auth.username, &body.current_password).await.is_none() {
        return Err(ApiError::unauthorized("current password is wrong"));
    }

    if let Err(err) = state.users.set_password(&auth.username, &body.new_password).await {
        return Err(ApiError::bad_request(err.to_string()));
    }

    state.sessions.invalidate_user(&auth.username).await;

    // Keep this browser logged in with a fresh session.
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));

    let token = state.sessions.create(&auth.username, ip.to_string()).await;
    let cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        state.sessions.timeout().as_secs()
    );

    let mut response = Json(json!({"ok": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|err| ApiError::internal(err.to_string()))?,
    );
    Ok(response)
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let hostname = tokio::fs::read_to_string("/proc/sys/kernel/hostname")
        .await
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|_| "unknown".to_owned());

    let daemon_info = match state.daemon.call_raw(DaemonRequest::SystemInfo).await {
        Ok(value) => Some(value),
        Err(_) => None,
    };

    Ok(Json(json!({
        "webui_version": state.version,
        "uptime_seconds": state.started.elapsed().as_secs(),
        "hostname": hostname,
        "daemon_connected": state.daemon.is_connected(),
        "daemon_endpoint": state.daemon.endpoint(),
        "sessions": state.sessions.count().await,
        "auth_enabled": state.auth_enabled(),
        "daemon": daemon_info,
    })))
}

async fn system_info(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let value = state.daemon.call_raw(DaemonRequest::SystemInfo).await?;
    Ok(Json(value))
}

// ---------------------------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------------------------

async fn require_auth(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    // Explicit opt-out (reverse proxy / loopback): treat every request as an administrator.
    if !state.auth_enabled() {
        req.extensions_mut().insert(AuthUser {
            username: "anonymous".to_owned(),
            role: Role::Admin,
        });
        return next.run(req).await;
    }

    let Some(token) = session_token(req.headers()) else {
        return ApiError::unauthorized("not logged in").into_response();
    };
    let token = token.to_owned();

    let Some(session) = state.sessions.validate(&token).await else {
        return ApiError::unauthorized("session expired").into_response();
    };

    // Resolve the role from the store on every request so demotion, disabling and deletion take
    // effect immediately instead of when the session happens to expire.
    let Some(role) = state.users.role_of(&session.username).await else {
        state.sessions.remove(&token).await;
        return ApiError::unauthorized("account disabled or removed").into_response();
    };

    let mutating = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let path = req.uri().path().to_owned();

    if mutating {
        if req.headers().get(CSRF_HEADER).is_none() {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                format!("missing {CSRF_HEADER} header"),
            )
            .into_response();
        }

        // Operators may only change their own password.
        let self_service = path == "/api/auth/password";
        if !role.is_admin() && !self_service {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                "this account is read-only (operator role)",
            )
            .into_response();
        }
    }

    req.extensions_mut().insert(AuthUser {
        username: session.username,
        role,
    });

    next.run(req).await
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie| cookie_value(cookie, SESSION_COOKIE))
}

fn client_ip(headers: &HeaderMap, addr: SocketAddr) -> IpAddr {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or_else(|| addr.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_for_wins_over_peer_address() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let peer: SocketAddr = "10.0.0.1:5000".parse().unwrap();
        assert_eq!(client_ip(&headers, peer).to_string(), "203.0.113.9");
    }

    #[test]
    fn peer_address_used_without_proxy_header() {
        let peer: SocketAddr = "192.168.1.5:5000".parse().unwrap();
        assert_eq!(
            client_ip(&HeaderMap::new(), peer).to_string(),
            "192.168.1.5"
        );
    }
}
