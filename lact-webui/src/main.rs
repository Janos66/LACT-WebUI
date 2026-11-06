use clap::Parser;
use lact_webui::{WebConfig, server};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "lact-webui",
    version,
    about = "Headless web UI for the LACT GPU control daemon",
    long_about = "Serves a browser front-end for LACT. The daemon (lactd) owns all hardware access; \
                  this process talks to it over its unix socket and exposes an authenticated HTTP \
                  API plus a single-page UI."
)]
struct Args {
    /// Path to the configuration file (default: /etc/lact/webui.yaml)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Override the listen address, e.g. 0.0.0.0:12800
    #[arg(short, long)]
    listen: Option<String>,

    /// Hash a password for `auth.password_hash` and exit
    #[arg(long, value_name = "PASSWORD")]
    hash_password: Option<String>,

    /// Print the default configuration as YAML and exit
    #[arg(long)]
    print_default_config: bool,

    /// Run without authentication (only safe behind a trusted reverse proxy)
    #[arg(long)]
    allow_unauthenticated: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    if let Some(password) = args.hash_password {
        println!("{}", lact_webui::config::hash_password(&password)?);
        return Ok(());
    }

    if args.print_default_config {
        print!("{}", serde_norway::to_string(&WebConfig::default())?);
        return Ok(());
    }

    server::run_standalone(server::RunOptions {
        config_path: args.config,
        listen: args.listen,
        allow_unauthenticated: args.allow_unauthenticated,
        ..Default::default()
    })
}
