//! Client for the LACT daemon's JSON protocol.
//!
//! The daemon speaks newline-delimited JSON over a unix socket (or TCP if the operator enabled
//! `tcp_listen_address` in `/etc/lact/config.yaml`). One request produces exactly one response:
//!
//! ```text
//! -> {"command":"device_stats","id":"0000:03:00.0"}\n
//! <- {"status":"ok","data":{ ... }}\n
//! ```
//!
//! The connection is stateful only in that requests must not overlap, so a single owning task
//! serializes all traffic; HTTP handlers submit work through a channel. This also means the daemon
//! never sees concurrent connections from the web UI, which keeps fan control curves coherent
//! (the daemon's internal state is per-connection for some operations, e.g. profile holds).

use crate::config::DaemonEndpoint;
use lact_schema::{Request, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{
        TcpStream, UnixStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        unix::{OwnedReadHalf as UnixReadHalf, OwnedWriteHalf as UnixWriteHalf},
    },
    sync::{mpsc, oneshot, watch},
};
use tracing::{debug, info, warn};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const PING_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum DaemonError {
    /// The daemon is not reachable (socket missing, connection refused, ...).
    Unavailable(String),
    /// The daemon answered with an error.
    Daemon(String),
    /// The request took too long.
    Timeout,
    /// The response could not be decoded. This indicates a schema mismatch with the daemon build.
    Decode(String),
}

impl std::fmt::Display for DaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(msg) => write!(f, "daemon unavailable: {msg}"),
            Self::Daemon(msg) => write!(f, "{msg}"),
            Self::Timeout => write!(f, "daemon did not answer in time"),
            Self::Decode(msg) => write!(f, "invalid response from daemon: {msg}"),
        }
    }
}

impl std::error::Error for DaemonError {}

impl DaemonError {
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable(_) | Self::Timeout)
    }
}

enum Connection {
    Unix {
        read: BufReader<UnixReadHalf>,
        write: UnixWriteHalf,
    },
    Tcp {
        read: BufReader<OwnedReadHalf>,
        write: OwnedWriteHalf,
    },
}

impl Connection {
    async fn request(&mut self, payload: &str) -> Result<String, DaemonError> {
        match self {
            Self::Unix { read, write } => exchange(read, write, payload).await,
            Self::Tcp { read, write } => exchange(read, write, payload).await,
        }
    }
}

async fn exchange<R, W>(
    read: &mut BufReader<R>,
    write: &mut W,
    payload: &str,
) -> Result<String, DaemonError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    write
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| DaemonError::Unavailable(err.to_string()))?;
    write
        .write_all(b"\n")
        .await
        .map_err(|err| DaemonError::Unavailable(err.to_string()))?;
    write
        .flush()
        .await
        .map_err(|err| DaemonError::Unavailable(err.to_string()))?;

    let mut line = String::new();
    let bytes = read
        .read_line(&mut line)
        .await
        .map_err(|err| DaemonError::Unavailable(err.to_string()))?;

    if bytes == 0 {
        return Err(DaemonError::Unavailable(
            "daemon closed the connection".to_owned(),
        ));
    }

    Ok(line)
}

struct Cmd {
    payload: String,
    reply: oneshot::Sender<Result<Value, DaemonError>>,
    timeout: Duration,
}

/// Handle used by HTTP handlers. Cheap to clone and `Send`.
#[derive(Clone)]
pub struct Daemon {
    tx: mpsc::Sender<Cmd>,
    connected: watch::Receiver<bool>,
    endpoint_label: Arc<str>,
}

impl Daemon {
    /// Spawn the owning task for the daemon connection.
    pub fn spawn(endpoint: DaemonEndpoint) -> Self {
        let (tx, rx) = mpsc::channel(64);
        let (connected_tx, connected_rx) = watch::channel(false);
        let endpoint_label: Arc<str> = Arc::from(endpoint.to_string());

        tokio::spawn(async move {
            let mut actor = Actor {
                endpoint,
                connection: None,
                connected: connected_tx,
            };
            actor.run(rx).await;
        });

        let daemon = Self {
            tx,
            connected: connected_rx,
            endpoint_label,
        };

        // Keep the connection state fresh even when the browser is idle, so `/api/status` and the
        // reconnect banner are accurate.
        let pinger = daemon.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(PING_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let _ = pinger.ping().await;
            }
        });

        daemon
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint_label
    }

    pub fn is_connected(&self) -> bool {
        *self.connected.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.connected.clone()
    }

    pub async fn ping(&self) -> Result<(), DaemonError> {
        let _: Value = self.call_raw(Request::Ping).await?;
        Ok(())
    }

    /// Send a request and return the raw `data` payload.
    pub async fn call_raw(&self, request: Request<'_>) -> Result<Value, DaemonError> {
        self.call_raw_timeout(request, DEFAULT_TIMEOUT).await
    }

    pub async fn call_raw_timeout(
        &self,
        request: Request<'_>,
        timeout: Duration,
    ) -> Result<Value, DaemonError> {
        let payload = serde_json::to_string(&request)
            .map_err(|err| DaemonError::Decode(err.to_string()))?;
        debug!("daemon request: {payload}");

        let (reply, response) = oneshot::channel();
        self.tx
            .send(Cmd {
                payload,
                reply,
                timeout,
            })
            .await
            .map_err(|_| DaemonError::Unavailable("web server is shutting down".to_owned()))?;

        response
            .await
            .map_err(|_| DaemonError::Unavailable("daemon task stopped".to_owned()))?
    }

    pub async fn call_typed<T: DeserializeOwned>(
        &self,
        request: Request<'_>,
    ) -> Result<T, DaemonError> {
        let value = self.call_raw(request).await?;
        serde_json::from_value(value).map_err(|err| DaemonError::Decode(err.to_string()))
    }

    pub async fn call_typed_timeout<T: DeserializeOwned>(
        &self,
        request: Request<'_>,
        timeout: Duration,
    ) -> Result<T, DaemonError> {
        let value = self.call_raw_timeout(request, timeout).await?;
        serde_json::from_value(value).map_err(|err| DaemonError::Decode(err.to_string()))
    }
}

struct Actor {
    endpoint: DaemonEndpoint,
    connection: Option<Connection>,
    connected: watch::Sender<bool>,
}

impl Actor {
    async fn run(&mut self, mut rx: mpsc::Receiver<Cmd>) {
        while let Some(cmd) = rx.recv().await {
            let result = self.execute(cmd.payload, cmd.timeout).await;
            let _ = cmd.reply.send(result);
        }
        debug!("daemon task finished");
    }

    async fn execute(
        &mut self,
        payload: String,
        timeout: Duration,
    ) -> Result<Value, DaemonError> {
        let attempt = async {
            if self.connection.is_none() {
                self.connection = Some(self.connect().await?);
            }

            let connection = self.connection.as_mut().expect("connection was just created");
            let line = connection.request(&payload).await?;
            parse_response(&line)
        };

        match tokio::time::timeout(timeout, attempt).await {
            Ok(Ok(value)) => {
                self.set_connected(true);
                Ok(value)
            }
            Ok(Err(err)) => {
                if err.is_unavailable() {
                    self.drop_connection();
                }
                Err(err)
            }
            Err(_) => {
                // A half-written request would desynchronize the stream, so start over.
                self.drop_connection();
                Err(DaemonError::Timeout)
            }
        }
    }

    fn drop_connection(&mut self) {
        self.connection = None;
        self.set_connected(false);
    }

    fn set_connected(&self, value: bool) {
        if *self.connected.borrow() != value {
            if value {
                info!("connected to LACT daemon at {}", self.endpoint);
            } else {
                warn!("lost connection to LACT daemon at {}", self.endpoint);
            }
            let _ = self.connected.send(value);
        }
    }

    async fn connect(&self) -> Result<Connection, DaemonError> {
        match &self.endpoint {
            DaemonEndpoint::Socket { socket: path } => {
                let socket = UnixStream::connect(PathBuf::from(path))
                    .await
                    .map_err(|err| {
                        DaemonError::Unavailable(format!("{}: {err}", path.display()))
                    })?;
                let (read, write) = socket.into_split();
                Ok(Connection::Unix {
                    read: BufReader::new(read),
                    write,
                })
            }
            DaemonEndpoint::Tcp { tcp: addr } => {
                let stream = TcpStream::connect(addr).await.map_err(|err| {
                    DaemonError::Unavailable(format!("tcp {addr}: {err}"))
                })?;
                stream
                    .set_nodelay(true)
                    .map_err(|err| DaemonError::Unavailable(err.to_string()))?;
                let (read, write) = stream.into_split();
                Ok(Connection::Tcp {
                    read: BufReader::new(read),
                    write,
                })
            }
        }
    }
}

fn parse_response(line: &str) -> Result<Value, DaemonError> {
    let response: Response<Value> = serde_json::from_str(line.trim())
        .map_err(|err| DaemonError::Decode(format!("{err}: {}", line.trim())))?;

    match response {
        Response::Ok(value) => Ok(value),
        Response::Error(error) => Err(DaemonError::Daemon(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ok_response() {
        let value = parse_response(r#"{"status":"ok","data":{"a":1}}"#).unwrap();
        assert_eq!(value["a"], 1);
    }

    #[test]
    fn surfaces_daemon_error() {
        let err = parse_response(
            r#"{"status":"error","data":{"description":"no such device","source":null}}"#,
        )
        .unwrap_err();
        assert!(matches!(err, DaemonError::Daemon(_)));
        assert!(err.to_string().contains("no such device"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            parse_response("not json").unwrap_err(),
            DaemonError::Decode(_)
        ));
    }
}
