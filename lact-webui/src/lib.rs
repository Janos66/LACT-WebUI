//! LACT WebUI — a headless browser front-end for the LACT GPU control daemon.
//!
//! The crate is split so it can be tested without hardware: [`daemon`] speaks the daemon's JSON
//! protocol, [`api`] exposes HTTP, and [`config`] handles operator settings.

pub mod api;
pub mod auth;
pub mod config;
pub mod daemon;
pub mod error;
pub mod server;
pub mod users;

pub use api::{AppState, router};
pub use config::WebConfig;
pub use daemon::Daemon;
pub use users::{Role, UserStore};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
