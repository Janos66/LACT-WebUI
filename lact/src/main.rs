//! LACT launcher.
//!
//! This fork replaces the GTK desktop application with a browser UI, so starting `lact` without a
//! subcommand now serves the web interface instead of opening a window. The `daemon` and `cli`
//! subcommands behave exactly as upstream.

use lact_schema::args::{Args, Command, GuiArgs, clap::Parser};

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let command = args
        .command
        .unwrap_or_else(|| Command::Gui(GuiArgs::default()));

    match command {
        Command::Daemon => lact_daemon::run(),
        Command::Gui(gui_args) => launch_web_ui(gui_args),
        Command::Cli(cli_args) => lact_cli::run(cli_args),
    }
}

/// The historic `gui` entry point now serves the web UI.
#[cfg(feature = "webui")]
fn launch_web_ui(args: GuiArgs) -> anyhow::Result<()> {
    let options = lact_webui::server::RunOptions {
        daemon: args.tcp_address.map(|tcp| lact_webui::config::DaemonEndpoint::Tcp { tcp }),
        log: args.log_level,
        ..Default::default()
    };

    lact_webui::server::run_standalone(options)
}

#[cfg(not(feature = "webui"))]
fn launch_web_ui(_: GuiArgs) -> anyhow::Result<()> {
    use anyhow::anyhow;
    Err(anyhow!(
        "LACT was built without the web UI feature (enable `--features webui`)"
    ))
}
