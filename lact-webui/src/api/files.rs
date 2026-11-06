//! Static assets (embedded from `../web`) and binary downloads produced by the daemon.

use super::AppState;
use crate::error::{ApiError, ApiResult};
use axum::{
    extract::State,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use std::time::Duration;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(RustEmbed)]
#[folder = "../web/"]
struct Assets;

pub async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"no such endpoint"}"#,
        )
            .into_response();
    }

    let asset = Assets::get(path).or_else(|| {
        // Single-page app: unknown paths without a file extension resolve to the shell.
        if std::path::Path::new(path).extension().is_none() {
            Assets::get("index.html")
        } else {
            None
        }
    });

    let Some(asset) = asset else {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain")],
            "not found",
        )
            .into_response();
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();

    // Code and shell are revalidated on every load: they are tiny, gzip-compressed, and a stale
    // bundle after an upgrade is far more expensive than the round trip. Images may be cached.
    let cache = match std::path::Path::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("js" | "css" | "html") => "no-cache, must-revalidate",
        _ => "public, max-age=86400",
    };

    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        asset.data.into_owned(),
    )
        .into_response()
}

pub async fn snapshot(State(state): State<AppState>) -> ApiResult<Response> {
    let path: String = state
        .daemon
        .call_typed_timeout(lact_schema::Request::GenerateSnapshot, SNAPSHOT_TIMEOUT)
        .await?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| ApiError::internal(format!("could not read snapshot {path}: {err}")))?;

    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "lact-snapshot.tar.gz".to_owned());

    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}
