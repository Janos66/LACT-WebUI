//! Session handling for the web UI.
//!
//! Sessions are random 256-bit tokens held in memory (the server is the only place they exist, so
//! there is nothing to persist or leak at rest). If the process restarts, browsers are logged out —
//! that is intentional for a root-privileged control plane.

use crate::config::AuthConfig;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

pub const SESSION_COOKIE: &str = "lact_session";

#[derive(Debug, Clone)]
pub struct Session {
    pub username: String,
    pub created: Instant,
    pub last_seen: Instant,
    pub remote: String,
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    timeout: Duration,
}

impl SessionStore {
    pub fn new(timeout_hours: u64) -> Self {
        let timeout = Duration::from_secs(timeout_hours.max(1) * 3600);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            timeout,
        }
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Create a new session for an authenticated user and return its token.
    pub async fn create(&self, username: &str, remote: String) -> String {
        let token = random_token();
        let now = Instant::now();

        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, session| now.duration_since(session.last_seen) < self.timeout);
        sessions.insert(
            token.clone(),
            Session {
                username: username.to_owned(),
                created: now,
                last_seen: now,
                remote,
            },
        );

        token
    }

    /// Validate a token, refreshing its idle timer.
    pub async fn validate(&self, token: &str) -> Option<Session> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(token)?;

        if session.last_seen.elapsed() >= self.timeout {
            sessions.remove(token);
            return None;
        }

        session.last_seen = Instant::now();
        Some(session.clone())
    }

    pub async fn remove(&self, token: &str) {
        self.sessions.write().await.remove(token);
    }

    /// Drop every session belonging to a user. Used when an account is deleted, disabled or has
    /// its password changed, so existing cookies stop working immediately.
    pub async fn invalidate_user(&self, username: &str) {
        self.sessions
            .write()
            .await
            .retain(|_, session| session.username != username);
    }

    pub async fn count(&self) -> usize {
        self.sessions.read().await.len()
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("failed to read random bytes from the kernel");
    hex::encode(bytes)
}

/// Per-IP failed login tracking.
#[derive(Debug)]
pub struct LoginLimiter {
    attempts: RwLock<HashMap<IpAddr, Attempts>>,
    max_attempts: u32,
    window: Duration,
}

#[derive(Debug)]
struct Attempts {
    count: u32,
    first: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoginCheck {
    Allowed,
    Blocked { retry_after: Duration },
}

impl LoginLimiter {
    pub fn new(config: &AuthConfig) -> Self {
        Self {
            attempts: RwLock::new(HashMap::new()),
            max_attempts: if config.max_attempts == 0 {
                5
            } else {
                config.max_attempts
            },
            window: Duration::from_secs(if config.attempt_window_secs == 0 {
                60
            } else {
                config.attempt_window_secs
            }),
        }
    }

    pub async fn check(&self, ip: IpAddr) -> LoginCheck {
        let mut attempts = self.attempts.write().await;

        let Some(entry) = attempts.get(&ip) else {
            return LoginCheck::Allowed;
        };

        if entry.first.elapsed() >= self.window {
            attempts.remove(&ip);
            return LoginCheck::Allowed;
        }

        if entry.count >= self.max_attempts {
            return LoginCheck::Blocked {
                retry_after: self.window.saturating_sub(entry.first.elapsed()),
            };
        }

        LoginCheck::Allowed
    }

    pub async fn record_failure(&self, ip: IpAddr) {
        let mut attempts = self.attempts.write().await;
        let entry = attempts.entry(ip).or_insert(Attempts {
            count: 0,
            first: Instant::now(),
        });

        if entry.first.elapsed() >= self.window {
            entry.count = 0;
            entry.first = Instant::now();
        }

        entry.count += 1;
    }

    pub async fn record_success(&self, ip: IpAddr) {
        self.attempts.write().await.remove(&ip);
    }
}

/// Extract a cookie value from a `Cookie` header.
pub fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key.trim() == name {
            Some(value.trim())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cookies() {
        let header = "other=1; lact_session=abc123; third=x";
        assert_eq!(cookie_value(header, SESSION_COOKIE), Some("abc123"));
        assert_eq!(cookie_value(header, "missing"), None);
    }

    #[tokio::test]
    async fn session_lifecycle() {
        let store = SessionStore::new(1);
        let token = store.create("alice", "127.0.0.1".into()).await;
        assert_eq!(token.len(), 64);
        assert!(store.validate(&token).await.is_some());
        assert!(store.validate("nope").await.is_none());

        store.remove(&token).await;
        assert!(store.validate(&token).await.is_none());
    }

    #[tokio::test]
    async fn invalidating_a_user_drops_only_their_sessions() {
        let store = SessionStore::new(1);
        let alice = store.create("alice", "127.0.0.1".into()).await;
        let bob = store.create("bob", "127.0.0.1".into()).await;

        store.invalidate_user("alice").await;

        assert!(store.validate(&alice).await.is_none());
        assert!(store.validate(&bob).await.is_some());
        assert_eq!(store.validate(&bob).await.unwrap().username, "bob");
    }

    #[tokio::test]
    async fn limiter_blocks_after_max_attempts() {
        let config = AuthConfig {
            max_attempts: 2,
            attempt_window_secs: 60,
            ..Default::default()
        };
        let limiter = LoginLimiter::new(&config);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();

        assert_eq!(limiter.check(ip).await, LoginCheck::Allowed);
        limiter.record_failure(ip).await;
        limiter.record_failure(ip).await;
        assert!(matches!(
            limiter.check(ip).await,
            LoginCheck::Blocked { .. }
        ));

        limiter.record_success(ip).await;
        assert_eq!(limiter.check(ip).await, LoginCheck::Allowed);
    }
}
