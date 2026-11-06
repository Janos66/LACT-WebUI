use clap::Parser;
use lact_webui::{Role, UserStore, WebConfig, server, users::DEFAULT_USERS_FILE};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "lact-webui",
    version,
    about = "Headless web UI for the LACT GPU control daemon",
    long_about = "Serves a browser front-end for LACT. The daemon (lactd) owns all hardware access; \
                  this process talks to it over its unix socket and exposes an authenticated HTTP \
                  API plus a single-page UI.\n\n\
                  Accounts are managed either here (--add-user) or from the Users page once an \
                  administrator exists. Roles: `admin` (full control) and `operator` (monitoring only)."
)]
struct Args {
    /// Path to the configuration file (default: /etc/lact/webui.yaml)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Override the listen address, e.g. 0.0.0.0:12800
    #[arg(short, long)]
    listen: Option<String>,

    /// Print the default configuration as YAML and exit
    #[arg(long)]
    print_default_config: bool,

    /// Run without authentication (only safe behind a trusted reverse proxy)
    #[arg(long)]
    allow_unauthenticated: bool,

    /// Account database to operate on (default: auth.users_file from the config, else /etc/lact/webui-users.yaml)
    #[arg(long, value_name = "PATH")]
    users_file: Option<PathBuf>,

    /// Create an account (prompts for the password)
    #[arg(long, value_name = "USERNAME")]
    add_user: Option<String>,

    /// Role for --add-user: admin or operator
    #[arg(long, value_name = "ROLE", default_value = "admin")]
    role: String,

    /// Read the password from stdin instead of prompting (for automation)
    #[arg(long)]
    password_stdin: bool,

    /// Reset an account's password (prompts for the new one)
    #[arg(long, value_name = "USERNAME")]
    set_password: Option<String>,

    /// Delete an account
    #[arg(long, value_name = "USERNAME")]
    remove_user: Option<String>,

    /// List accounts and exit
    #[arg(long)]
    list_users: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    if args.print_default_config {
        print!("{}", serde_norway::to_string(&WebConfig::default())?);
        return Ok(());
    }

    let users_path = resolve_users_path(args.config.as_deref(), args.users_file)?;

    // ---- account management subcommands ------------------------------------------------
    if let Some(username) = args.add_user {
        let role = Role::parse(&args.role)
            .ok_or_else(|| anyhow::anyhow!("unknown role `{}`, expected admin or operator", args.role))?;

        let password = read_password(args.password_stdin, "Password: ", true)?;
        let store = UserStore::load(&users_path)?;

        block_on(store.create(username.trim(), &password, role))?;
        println!(
            "created {} account `{}` in {}",
            role,
            username.trim(),
            store.path().display()
        );
        return Ok(());
    }

    if let Some(username) = args.set_password {
        let password = read_password(args.password_stdin, "New password: ", true)?;
        let store = UserStore::load(&users_path)?;
        block_on(store.set_password(&username, &password))?;
        println!("password updated for `{username}`");
        return Ok(());
    }

    if let Some(username) = args.remove_user {
        let store = UserStore::load(&users_path)?;
        block_on(store.remove(&username))?;
        println!("removed account `{username}`");
        return Ok(());
    }

    if args.list_users {
        let store = UserStore::load(&users_path)?;
        let users = block_on(store.list());

        if users.is_empty() {
            println!("no accounts in {}", store.path().display());
        } else {
            println!("{:<20} {:<10} {:<10} {}", "USERNAME", "ROLE", "STATUS", "CREATED");
            for user in users {
                let status = if user.disabled { "disabled" } else { "active" };
                println!(
                    "{:<20} {:<10} {:<10} {}",
                    user.username,
                    user.role.as_str(),
                    status,
                    user.created_at
                );
            }
        }
        return Ok(());
    }

    // ---- serve -------------------------------------------------------------------------
    server::run_standalone(server::RunOptions {
        config_path: args.config,
        listen: args.listen,
        allow_unauthenticated: args.allow_unauthenticated,
        users_file: Some(users_path),
        ..Default::default()
    })
}

/// Users file: explicit flag > config file > built-in default.
fn resolve_users_path(config_path: Option<&std::path::Path>, explicit: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path);
    }

    let (config, _) = WebConfig::load(config_path)?;
    Ok(config.auth.users_file)
}

fn read_password(from_stdin: bool, prompt: &str, confirm: bool) -> anyhow::Result<String> {
    let password = if from_stdin {
        let mut buffer = String::new();
        std::io::stdin().read_line(&mut buffer)?;
        buffer.trim_end_matches(['\n', '\r']).to_owned()
    } else {
        rpassword::prompt_password(prompt)?
    };

    if confirm && !from_stdin {
        let again = rpassword::prompt_password("Repeat password: ")?;
        if password != again {
            anyhow::bail!("passwords do not match");
        }
    }

    lact_webui::users::validate_password(&password)?;
    Ok(password)
}

/// These subcommands are one-shot, so a minimal current-thread runtime is enough.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("could not start the async runtime")
        .block_on(future)
}

#[allow(dead_code)]
const _: &str = DEFAULT_USERS_FILE;
