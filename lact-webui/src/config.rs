//! Configuration for the LACT web UI server.
//!
//! The file is YAML and lives at `/etc/lact/webui.yaml` by default. Every field has a default, so an
//! empty (or missing) file is valid — except that serving on a non-loopback address without a
//! password is refused unless `allow_unauthenticated` is explicitly set.

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::{
    fmt::{self, Display},
    net::SocketAddr,
    path::{Path, PathBuf},
};

pub const DEFAULT_CONFIG_PATH: &str = "/etc/lact/webui.yaml";
pub const DEFAULT_LISTEN: &str = "0.0.0.0:12800";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WebConfig {
    /// Address to serve the web UI on, e.g. `0.0.0.0:12800` or `127.0.0.1:12800`.
    pub listen: String,
    /// Where the daemon listens. Unix socket is strongly preferred.
    pub daemon: DaemonEndpoint,
    /// Session lifetime, in hours.
    pub session_timeout_hours: u64,
    /// Allow serving without any authentication. Only sane behind a trusted reverse proxy.
    pub allow_unauthenticated: bool,
    pub auth: AuthConfig,
    /// Default interval for the websocket statistics stream, in milliseconds.
    pub refresh_interval_ms: u64,
    /// Optional allowlist of GPU ids that this instance exposes. Empty = all devices.
    pub device_allowlist: Vec<String>,
    /// Log filter, e.g. `info` or `lact_webui=debug,tower_http=info`.
    pub log: String,
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            listen: DEFAULT_LISTEN.to_owned(),
            daemon: DaemonEndpoint::default(),
            session_timeout_hours: 12,
            allow_unauthenticated: false,
            auth: AuthConfig::default(),
            refresh_interval_ms: 1000,
            device_allowlist: Vec::new(),
            log: "info,tower_http=warn".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    /// Argon2id hash of the password. Generate one with `lact-webui --hash-password`.
    pub password_hash: Option<String>,
    /// Maximum failed login attempts per window before the client is blocked.
    pub max_attempts: u32,
    pub attempt_window_secs: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            password_hash: None,
            max_attempts: 5,
            attempt_window_secs: 60,
        }
    }
}

/// Where the daemon listens. Written in YAML as `{ socket: /run/lactd.sock }` or
/// `{ tcp: "127.0.0.1:12853" }`; untagged so both spellings stay readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DaemonEndpoint {
    Socket { socket: PathBuf },
    Tcp { tcp: String },
}

impl Default for DaemonEndpoint {
    fn default() -> Self {
        Self::Socket {
            socket: PathBuf::from("/run/lactd.sock"),
        }
    }
}

impl Display for DaemonEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Socket { socket } => write!(f, "unix:{}", socket.display()),
            Self::Tcp { tcp } => write!(f, "tcp:{tcp}"),
        }
    }
}

impl WebConfig {
    pub fn load(path: Option<&Path>) -> anyhow::Result<(Self, Option<PathBuf>)> {
        let path = path.map(Path::to_path_buf).or_else(default_config_path);

        let Some(path) = path else {
            return Ok((Self::default(), None));
        };

        if !path.exists() {
            return Ok((Self::default(), None));
        }

        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("could not read config file {}", path.display()))?;
        let config: Self = serde_norway::from_str(&contents)
            .with_context(|| format!("could not parse config file {}", path.display()))?;

        Ok((config, Some(path)))
    }

    pub fn socket_addr(&self) -> anyhow::Result<SocketAddr> {
        self.listen
            .parse()
            .with_context(|| format!("invalid listen address `{}`", self.listen))
    }

    /// Reject configurations that would expose GPU control to the network without a password.
    pub fn validate(&self) -> anyhow::Result<()> {
        let addr = self.socket_addr()?;

        if self.allow_unauthenticated {
            return Ok(());
        }

        if self.auth.password_hash.is_none() {
            if addr.ip().is_loopback() {
                return Ok(());
            }

            bail!(
                "refusing to listen on {} without authentication.\n\
                 Set `auth.password_hash` (see `lact-webui --hash-password`) or, if a reverse \
                 proxy authenticates users for you, set `allow_unauthenticated: true`.",
                self.listen
            );
        }

        Ok(())
    }

    pub fn auth_enabled(&self) -> bool {
        !self.allow_unauthenticated && self.auth.password_hash.is_some()
    }
}

fn default_config_path() -> Option<PathBuf> {
    let path = PathBuf::from(DEFAULT_CONFIG_PATH);
    if path.exists() {
        return Some(path);
    }

    if let Ok(path) = std::env::var("LACT_WEBUI_CONFIG") {
        return Some(PathBuf::from(path));
    }

    None
}

/// Hash a password for storage in the config file.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    use argon2::{
        Argon2, PasswordHasher,
        password_hash::SaltString,
    };

    let mut salt_bytes = [0u8; 16];
    getrandom::getrandom(&mut salt_bytes)
        .map_err(|err| anyhow::anyhow!("could not read random bytes: {err}"))?;

    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|err| anyhow::anyhow!("could not encode salt: {err}"))?;

    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|err| anyhow::anyhow!("could not hash password: {err}"))?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    use argon2::{Argon2, PasswordVerifier, password_hash::PasswordHash};

    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };

    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}
