//! User accounts and roles.
//!
//! LACT WebUI has two roles:
//!
//! * [`Role::Admin`] — full access: every monitoring endpoint plus all mutating operations
//!   (applying GPU configs, fan curves, power limits, profiles, user management).
//! * [`Role::Operator`] — monitoring only. Every non-`GET` request is rejected with `403`, so the
//!   restriction is enforced on the server, not just hidden in the UI.
//!
//! Accounts live in a YAML file (default `/etc/lact/webui-users.yaml`) written with mode `0600` and
//! replaced atomically. Passwords are Argon2id hashes; the plaintext never touches the disk.

use crate::config::{hash_password, verify_password};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt::{self, Display},
    io::Write,
    path::{Path, PathBuf},
};
use tokio::sync::RwLock;

pub const DEFAULT_USERS_FILE: &str = "/etc/lact/webui-users.yaml";
pub const MIN_PASSWORD_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Operator,
}

impl Default for Role {
    fn default() -> Self {
        Self::Operator
    }
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Operator => "operator",
        }
    }

    pub fn is_admin(self) -> bool {
        matches!(self, Self::Admin)
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "admin" => Some(Self::Admin),
            "operator" => Some(Self::Operator),
            _ => None,
        }
    }
}

impl Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    /// Argon2id PHC string.
    pub password_hash: String,
    #[serde(default)]
    pub role: Role,
    /// Unix timestamp of account creation.
    #[serde(default)]
    pub created_at: u64,
    /// Disabled accounts keep their entry but cannot log in.
    #[serde(default)]
    pub disabled: bool,
}

/// Public view of an account, safe to send to the browser.
#[derive(Debug, Clone, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub role: Role,
    pub created_at: u64,
    pub disabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsersFile {
    #[serde(default)]
    users: BTreeMap<String, User>,
}

#[derive(Debug)]
pub struct UserStore {
    path: PathBuf,
    users: RwLock<BTreeMap<String, User>>,
}

impl UserStore {
    /// Load the store, or start empty when the file does not exist yet.
    pub fn load(path: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let path = path.into();

        let users = if path.exists() {
            let contents = std::fs::read_to_string(&path)?;
            let file: UsersFile = serde_norway::from_str(&contents)
                .map_err(|err| anyhow::anyhow!("could not parse {}: {err}", path.display()))?;
            file.users
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            path,
            users: RwLock::new(users),
        })
    }

    /// Re-read the users file when it changed on disk. The account-management CLI subcommands
    /// (`--add-user`, `--set-password`, `--remove-user`, `--disable-user`) edit the file while
    /// the server keeps running, so without this those changes would only appear after a restart
    /// and revocation would not be immediate. The CLI writes the file atomically (rename), so a
    /// reader never sees a half-written file; a missing file is treated as an empty store.
    /// Re-read the users file. The account-management CLI subcommands edit the file while the
    /// server keeps running, so every account check re-reads it: this makes external changes
    /// (create, set-password, disable, remove) take effect without a restart and revocation
    /// immediate. The file is a small YAML document, so a per-request read is trivial. When the
    /// file cannot be read or parsed, the last known-good snapshot is kept so a transient bad
    /// file cannot lock everybody out.
    async fn reload_from_disk(&self) {
        let contents = match std::fs::read_to_string(&self.path).ok() {
            Some(contents) => contents,
            None => return,
        };

        let Some(file) = serde_norway::from_str::<UsersFile>(&contents).ok() else {
            return;
        };

        *self.users.write().await = file.users;
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn is_empty(&self) -> bool {
        self.reload_from_disk().await;
        self.users.read().await.is_empty()
    }

    pub async fn len(&self) -> usize {
        self.reload_from_disk().await;
        self.users.read().await.len()
    }

    pub async fn count_admins(&self) -> usize {
        self.reload_from_disk().await;
        self.users
            .read()
            .await
            .values()
            .filter(|user| user.role.is_admin() && !user.disabled)
            .count()
    }

    pub async fn list(&self) -> Vec<UserInfo> {
        self.reload_from_disk().await;
        self.users
            .read()
            .await
            .iter()
            .map(|(username, user)| UserInfo {
                username: username.clone(),
                role: user.role,
                created_at: user.created_at,
                disabled: user.disabled,
            })
            .collect()
    }

    pub async fn role_of(&self, username: &str) -> Option<Role> {
        self.users
            .read()
            .await
            .get(username)
            .filter(|user| !user.disabled)
            .map(|user| user.role)
    }

    pub async fn is_disabled_or_missing(&self, username: &str) -> bool {
        self.reload_from_disk().await;
        self.users
            .read()
            .await
            .get(username)
            .is_none_or(|user| user.disabled)
    }

    /// Verify credentials. The Argon2 work happens on a blocking thread.
    pub async fn authenticate(&self, username: &str, password: &str) -> Option<Role> {
        self.reload_from_disk().await;
        let (hash, role, disabled) = {
            let users = self.users.read().await;
            let user = users.get(username)?;
            (user.password_hash.clone(), user.role, user.disabled)
        };

        if disabled {
            return None;
        }

        let password = password.to_owned();
        let valid = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
            .await
            .unwrap_or(false);

        valid.then_some(role)
    }

    pub async fn create(
        &self,
        username: &str,
        password: &str,
        role: Role,
    ) -> anyhow::Result<()> {
        validate_username(username)?;
        validate_password(password)?;

        let hash = hash_password(password)?;
        let created_at = now();

        {
            let mut users = self.users.write().await;
            if users.contains_key(username) {
                anyhow::bail!("user `{username}` already exists");
            }
            users.insert(
                username.to_owned(),
                User {
                    password_hash: hash,
                    role,
                    created_at,
                    disabled: false,
                },
            );
        }

        self.persist().await
    }

    pub async fn set_role(&self, username: &str, role: Role) -> anyhow::Result<()> {
        {
            let mut users = self.users.write().await;

            let current = users
                .get(username)
                .ok_or_else(|| anyhow::anyhow!("no such user: {username}"))?
                .role;

            // Refuse to leave the system without a usable admin.
            if current.is_admin() && !role.is_admin() && active_admins(&users) <= 1 {
                anyhow::bail!("cannot demote the last admin account");
            }

            if let Some(user) = users.get_mut(username) {
                user.role = role;
            }
        }

        self.persist().await
    }

    pub async fn set_password(&self, username: &str, password: &str) -> anyhow::Result<()> {
        validate_password(password)?;
        let hash = hash_password(password)?;

        {
            let mut users = self.users.write().await;
            let user = users
                .get_mut(username)
                .ok_or_else(|| anyhow::anyhow!("no such user: {username}"))?;
            user.password_hash = hash;
        }

        self.persist().await
    }

    pub async fn set_disabled(&self, username: &str, disabled: bool) -> anyhow::Result<()> {
        {
            let mut users = self.users.write().await;

            let current = users
                .get(username)
                .ok_or_else(|| anyhow::anyhow!("no such user: {username}"))?
                .role;

            if disabled && current.is_admin() && active_admins(&users) <= 1 {
                anyhow::bail!("cannot disable the last admin account");
            }

            if let Some(user) = users.get_mut(username) {
                user.disabled = disabled;
            }
        }

        self.persist().await
    }

    pub async fn remove(&self, username: &str) -> anyhow::Result<()> {
        {
            let mut users = self.users.write().await;
            let user = users
                .get(username)
                .ok_or_else(|| anyhow::anyhow!("no such user: {username}"))?;

            if user.role.is_admin() && active_admins(&users) <= 1 {
                anyhow::bail!("cannot delete the last admin account");
            }

            users.remove(username);
        }

        self.persist().await
    }

    /// Write the store atomically with restrictive permissions.
    async fn persist(&self) -> anyhow::Result<()> {
        let users = self.users.read().await.clone();

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            if let Some(parent) = self.path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }

            let temp_path = self.path.with_extension("yaml.tmp");
            let contents = serde_norway::to_string(&UsersFile { users })?;

            {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&temp_path)?;
                file.write_all(contents.as_bytes())?;
                file.sync_all()?;
            }

            std::fs::rename(&temp_path, &self.path)?;
        }

        #[cfg(not(unix))]
        {
            let contents = serde_norway::to_string(&UsersFile { users })?;
            std::fs::write(&self.path, contents)?;
        }

        Ok(())
    }
}

fn active_admins(users: &BTreeMap<String, User>) -> usize {
    users
        .values()
        .filter(|user| user.role.is_admin() && !user.disabled)
        .count()
}

pub fn validate_username(username: &str) -> anyhow::Result<()> {
    let trimmed = username.trim();

    if trimmed.len() < 2 || trimmed.len() > 32 {
        anyhow::bail!("username must be between 2 and 32 characters");
    }

    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        anyhow::bail!("username may only contain letters, digits, '.', '_' and '-'");
    }

    Ok(())
}

pub fn validate_password(password: &str) -> anyhow::Result<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        anyhow::bail!("password must be at least {MIN_PASSWORD_LEN} characters long");
    }
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> (UserStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = UserStore::load(dir.path().join("users.yaml")).unwrap();
        (store, dir)
    }

    /// The CLI subcommands edit the users file while the server runs; the store must pick
    /// those changes up without a restart, or revocation is not immediate.
    #[tokio::test]
    async fn picks_up_external_changes() {
        let (store, dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();

        // Simulate a CLI edit: rewrite the file with the account disabled.
        let path = dir.path().join("users.yaml");
        let contents = std::fs::read_to_string(&path).unwrap();
        let edited = contents.replace("disabled: false", "disabled: true");
        assert_ne!(edited, contents);
        std::fs::write(&path, edited).unwrap();

        assert_eq!(store.authenticate("alice", "correct horse").await, None);
        assert!(store.is_disabled_or_missing("alice").await);

        // Simulate the CLI creating a new account in the same file.
        let mut edited = std::fs::read_to_string(&path).unwrap();
        let added = edited.replace("users:", "users:\n  newuser:\n    password_hash: $argon2id$v=19$m=19456,t=2,p=1$x$y\n    role: operator\n    disabled: false\n    created_at: 1");
        std::fs::write(&path, added).unwrap();

        assert_eq!(store.is_disabled_or_missing("newuser").await, false);
        assert_eq!(store.authenticate("alice", "correct horse").await, None);
        assert_eq!(store.authenticate("alice", "correct horse").await, None);
    }

    #[tokio::test]
    async fn creates_and_authenticates() {
        let (store, _dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();

        assert_eq!(
            store.authenticate("alice", "correct horse").await,
            Some(Role::Admin)
        );
        assert_eq!(store.authenticate("alice", "wrong").await, None);
        assert_eq!(store.authenticate("bob", "correct horse").await, None);
    }

    #[tokio::test]
    async fn persists_across_reload() {
        let (store, dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();
        drop(store);

        let reloaded = UserStore::load(dir.path().join("users.yaml")).unwrap();
        assert_eq!(reloaded.len().await, 1);
        assert_eq!(
            reloaded.authenticate("alice", "correct horse").await,
            Some(Role::Admin)
        );
    }

    #[tokio::test]
    async fn rejects_duplicates_and_weak_input() {
        let (store, _dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();

        assert!(store.create("alice", "another one", Role::Operator).await.is_err());
        assert!(store.create("bob", "short", Role::Operator).await.is_err());
        assert!(store.create("bad name", "correct horse", Role::Operator).await.is_err());
    }

    #[tokio::test]
    async fn protects_the_last_admin() {
        let (store, _dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();
        store.create("bob", "correct horse", Role::Operator).await.unwrap();

        assert!(store.set_role("alice", Role::Operator).await.is_err());
        assert!(store.remove("alice").await.is_err());
        assert!(store.set_disabled("alice", true).await.is_err());

        // With a second admin, demotion is allowed.
        store.set_role("bob", Role::Admin).await.unwrap();
        store.set_role("alice", Role::Operator).await.unwrap();
        assert_eq!(store.count_admins().await, 1);
    }

    #[tokio::test]
    async fn disabled_accounts_cannot_log_in() {
        let (store, _dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();
        // A second admin, otherwise disabling the only one is (correctly) refused.
        store.create("bob", "correct horse", Role::Admin).await.unwrap();
        store.set_disabled("alice", true).await.unwrap();

        assert_eq!(store.authenticate("alice", "correct horse").await, None);
        assert!(store.role_of("alice").await.is_none());
    }

    #[tokio::test]
    async fn password_change_takes_effect() {
        let (store, _dir) = store().await;
        store.create("alice", "correct horse", Role::Admin).await.unwrap();
        store.set_password("alice", "battery staple").await.unwrap();

        assert_eq!(store.authenticate("alice", "correct horse").await, None);
        assert_eq!(
            store.authenticate("alice", "battery staple").await,
            Some(Role::Admin)
        );
    }
}
