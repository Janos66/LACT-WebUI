//! Settings profile endpoints.

use super::AppState;
use crate::error::{ApiError, ApiResult};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use lact_schema::{
    Request as DaemonRequest,
    ProfileRule,
    config::{Profile, ProfileHooks},
    request::ProfileBase,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let include_state = query
        .get("include_state")
        .is_some_and(|value| value == "true");

    Ok(Json(
        state
            .daemon
            .call_raw(DaemonRequest::ListProfiles { include_state })
            .await?,
    ))
}

pub async fn get(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .daemon
            .call_raw(DaemonRequest::GetProfile { name: Some(name) })
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub base: ProfileBase,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::CreateProfile {
            name: body.name,
            base: body.base,
        })
        .await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::DeleteProfile { name })
        .await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct ActivateBody {
    #[serde(default)]
    pub auto_switch: bool,
}

pub async fn activate(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<ActivateBody>,
) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::SetProfile {
            name: Some(name),
            auto_switch: body.auto_switch,
        })
        .await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub new_name: String,
}

pub async fn rename(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RenameBody>,
) -> ApiResult<Json<Value>> {
    if body.new_name.trim().is_empty() {
        return Err(ApiError::bad_request("new profile name is empty"));
    }

    state
        .daemon
        .call_raw(DaemonRequest::RenameProfile {
            name,
            new_name: body.new_name,
        })
        .await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct MoveBody {
    pub new_position: usize,
}

pub async fn move_profile(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<MoveBody>,
) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::MoveProfile {
            name,
            new_position: body.new_position,
        })
        .await?;
    Ok(Json(json!({"ok": true})))
}

/// Returns the rule and hooks attached to a profile.
pub async fn get_rule(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let profile: Option<Profile> = state
        .daemon
        .call_typed(DaemonRequest::GetProfile { name: Some(name) })
        .await?;

    match profile {
        Some(profile) => Ok(Json(json!({
            "rule": profile.rule,
            "hooks": profile.hooks,
        }))),
        None => Err(ApiError::not_found("no such profile")),
    }
}

#[derive(Deserialize)]
pub struct RuleBody {
    #[serde(default)]
    pub rule: Option<ProfileRule>,
    #[serde(default)]
    pub hooks: ProfileHooks,
}

pub async fn set_rule(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RuleBody>,
) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::SetProfileRule {
            name,
            rule: body.rule,
            hooks: body.hooks,
        })
        .await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn evaluate_rule(
    State(state): State<AppState>,
    Json(rule): Json<ProfileRule>,
) -> ApiResult<Json<Value>> {
    let matches = state
        .daemon
        .call_raw(DaemonRequest::EvaluateProfileRule { rule })
        .await?;
    Ok(Json(json!({ "matches": matches })))
}

pub async fn enable_overdrive(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::EnableOverdrive)
        .await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn disable_overdrive(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state
        .daemon
        .call_raw(DaemonRequest::DisableOverdrive)
        .await
        .map_err(|err| ApiError::new(StatusCode::CONFLICT, err.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

pub async fn reset_config(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state.daemon.call_raw(DaemonRequest::RestConfig).await?;
    Ok(Json(json!({"ok": true})))
}
