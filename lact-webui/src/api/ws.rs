//! Live statistics stream.
//!
//! One websocket per browser tab. The client asks for a device, the server polls the daemon at the
//! requested interval and forwards `DeviceStats`. Connection loss is reported as an event rather
//! than a closed socket, so the UI can keep its last values visible while showing a banner.

use super::AppState;
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use lact_schema::Request as DaemonRequest;
use serde_json::{Value, json};
use std::time::Duration;
use tracing::debug;

const MIN_INTERVAL_MS: u64 = 200;
const MAX_INTERVAL_MS: u64 = 10_000;

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| run(socket, state))
}

async fn run(mut socket: WebSocket, state: AppState) {
    let mut selected: Option<String> = None;
    let mut interval = Duration::from_millis(state.config.refresh_interval_ms.clamp(
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
    ));
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut connected_rx = state.daemon.subscribe();

    send(
        &mut socket,
        json!({
            "type": "hello",
            "daemon_connected": state.daemon.is_connected(),
            "interval_ms": interval.as_millis() as u64,
        }),
    )
    .await;

    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            match value.get("type").and_then(Value::as_str) {
                                Some("select") => {
                                    selected = value
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned);
                                    debug!("websocket subscribing to {selected:?}");
                                }
                                Some("interval") => {
                                    if let Some(ms) = value.get("ms").and_then(Value::as_u64) {
                                        let ms = ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
                                        interval = Duration::from_millis(ms);
                                        ticker = tokio::time::interval(interval);
                                        ticker.set_missed_tick_behavior(
                                            tokio::time::MissedTickBehavior::Delay,
                                        );
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }

            _ = ticker.tick() => {
                let Some(id) = selected.clone() else { continue };

                match state.daemon.call_raw(DaemonRequest::DeviceStats { id: &id }).await {
                    Ok(stats) => {
                        let payload = json!({ "type": "stats", "id": id, "stats": stats });
                        if !send(&mut socket, payload).await {
                            break;
                        }
                    }
                    Err(err) => {
                        let payload = json!({
                            "type": "error",
                            "message": err.to_string(),
                            "daemon_connected": !err.is_unavailable(),
                        });
                        if !send(&mut socket, payload).await {
                            break;
                        }
                    }
                }
            }

            changed = connected_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let connected = *connected_rx.borrow();
                let payload = json!({ "type": "daemon", "connected": connected });
                if !send(&mut socket, payload).await {
                    break;
                }
            }
        }
    }

    debug!("websocket closed");
}

async fn send(socket: &mut WebSocket, payload: Value) -> bool {
    socket.send(Message::Text(payload.to_string().into())).await.is_ok()
}
