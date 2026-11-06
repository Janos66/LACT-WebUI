//! Server bootstrap shared by the `lact-webui` binary and the `lact` launcher.

use crate::{AppState, Daemon, WebConfig, api::router};
use anyhow::Context;
use std::{net::SocketAddr, path::PathBuf};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

pub async fn serve(config: WebConfig) -> anyhow::Result<()> {
    let addr = config.socket_addr()?;
    let daemon_endpoint = config.daemon.clone();
    let daemon = Daemon::spawn(daemon_endpoint.clone());

    let state = AppState::new(config.clone(), daemon);
    let sessions = state.sessions.clone();
    let auth_enabled = state.auth_enabled();
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not bind to {addr}"))?;

    info!(
        "LACT WebUI {} listening on http://{addr} (daemon: {daemon_endpoint})",
        crate::VERSION
    );

    if !auth_enabled {
        if config.allow_unauthenticated {
            warn!("authentication is DISABLED — anyone who can reach this port controls the GPU");
        } else {
            info!("loopback-only instance without authentication");
        }
    } else {
        info!("password authentication enabled");
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server error")?;

    info!(
        "shutting down, {} active session(s)",
        sessions.count().await
    );
    Ok(())
}

/// Options for a standalone web UI run, used by both binaries.
#[derive(Debug, Default)]
pub struct RunOptions {
    pub config_path: Option<PathBuf>,
    pub listen: Option<String>,
    pub allow_unauthenticated: bool,
    pub daemon: Option<crate::config::DaemonEndpoint>,
    pub log: Option<String>,
}

/// Load configuration, initialise logging and run the server on a fresh multi-threaded runtime.
/// Used by the `lact` launcher, which is a synchronous binary.
pub fn run_standalone(options: RunOptions) -> anyhow::Result<()> {
    let RunOptions {
        config_path,
        listen,
        allow_unauthenticated,
        daemon,
        log,
    } = options;

    let (mut config, path) = WebConfig::load(config_path.as_deref())?;

    if let Some(listen) = listen {
        config.listen = listen;
    }
    if allow_unauthenticated {
        config.allow_unauthenticated = true;
    }
    if let Some(daemon) = daemon {
        config.daemon = daemon;
    }
    if let Some(log) = log {
        config.log = log;
    }

    init_tracing(&config.log);

    match &path {
        Some(path) => info!("configuration loaded from {}", path.display()),
        None => info!("no configuration file found, using defaults"),
    }

    config.validate()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("could not start the async runtime")?;

    runtime.block_on(serve(config))
}

pub fn init_tracing(filter: &str) {
    let filter = std::env::var("RUST_LOG")
        .ok()
        .unwrap_or_else(|| filter.to_owned());

    let filter = EnvFilter::try_new(&filter).unwrap_or_else(|_| EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}
