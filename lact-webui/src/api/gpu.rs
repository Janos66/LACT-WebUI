//! GPU endpoints. These are thin, typed wrappers around the daemon protocol: the daemon owns all
//! hardware access and validation, the web UI never re-implements it.

use super::AppState;
use crate::{
    daemon::DaemonError,
    error::{ApiError, ApiResult},
};
use amdgpu_sysfs::gpu_handle::{PerformanceLevel, PowerLevelKind};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use lact_schema::{
    DeviceInfo, DeviceStats, FanControlMode, FanCurveMap, FanOptions, PmfwOptions,
    Request as DaemonRequest,
    config::GpuConfig,
    request::{ConfirmCommand, SetClocksCommand},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const VBIOS_TIMEOUT: Duration = Duration::from_secs(60);

fn ensure_allowed(state: &AppState, id: &str) -> ApiResult<()> {
    let allowlist = &state.config.device_allowlist;
    if allowlist.is_empty() || allowlist.iter().any(|allowed| allowed == id) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("device {id} is not exposed by this instance"),
        ))
    }
}

async fn call(state: &AppState, request: DaemonRequest<'_>) -> ApiResult<Json<Value>> {
    Ok(Json(state.daemon.call_raw(request).await?))
}

/// The daemon reports its auto-revert delay in seconds (`Config::apply_settings_timer`,
/// consumed as `Duration::from_secs` in `handler.rs::wait_config_confirm`); the browser expects
/// milliseconds. Scaling happens here, in the webui layer, so the daemon stays upstream.
fn auto_revert_ms(seconds: u64) -> Json<Value> {
    Json(json!({ "auto_revert_ms": seconds * 1000 }))
}

pub async fn list_devices(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let value = state.daemon.call_raw(DaemonRequest::ListDevices).await?;

    let Some(devices) = value.as_array() else {
        return Ok(Json(value));
    };

    let allowlist = &state.config.device_allowlist;
    if allowlist.is_empty() {
        return Ok(Json(value));
    }

    let filtered: Vec<Value> = devices
        .iter()
        .filter(|device| {
            device
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| allowlist.iter().any(|allowed| allowed == id))
        })
        .cloned()
        .collect();

    Ok(Json(Value::Array(filtered)))
}

pub async fn device_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    let include_api_info = query.get("api_info").map(|value| value == "true");

    call(
        &state,
        DaemonRequest::DeviceInfo {
            id: &id,
            include_api_info,
        },
    )
    .await
}

pub async fn api_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::DeviceApiInfo { id: &id }).await
}

pub async fn device_stats(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::DeviceStats { id: &id }).await
}

pub async fn clocks_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::DeviceClocksInfo { id: &id }).await
}

pub async fn power_profile_modes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(
        &state,
        DaemonRequest::DevicePowerProfileModes { id: &id },
    )
    .await
}

pub async fn get_power_states(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::GetPowerStates { id: &id }).await
}

pub async fn displays(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::DisplaysInfo { id: &id }).await
}

pub async fn processes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::ProcessList { id: &id }).await
}

/// Server-rendered information rows. Upstream's GTK app builds these from
/// `DeviceInfo::info_elements()`, which also handles the AMD/Nvidia/Intel specific formatting; the
/// web UI reuses the exact same function so labels and values cannot drift.
pub async fn info_rows(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let info: DeviceInfo = state
        .daemon
        .call_typed(DaemonRequest::DeviceInfo {
            id: &id,
            include_api_info: None,
        })
        .await?;

    let stats: Option<DeviceStats> = state
        .daemon
        .call_typed(DaemonRequest::DeviceStats { id: &id })
        .await
        .ok();

    let rows: Vec<Value> = info
        .info_elements(stats.as_ref())
        .into_iter()
        .filter_map(|(name, value)| {
            value.map(|value| json!({"name": name, "value": value}))
        })
        .collect();

    Ok(Json(Value::Array(rows)))
}

pub async fn get_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    call(&state, DaemonRequest::GetGpuConfig { id: &id }).await
}

pub async fn set_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let config: GpuConfig = serde_json::from_value(body)
        .map_err(|err| ApiError::bad_request(format!("invalid GPU config: {err}")))?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetGpuConfig {
            id: &id,
            config: Box::new(config),
        })
        .await?;

    Ok(auto_revert_ms(value))
}

#[derive(Deserialize)]
pub struct ConfirmBody {
    command: String,
}

pub async fn confirm_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ConfirmBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let command = match body.command.as_str() {
        "confirm" => ConfirmCommand::Confirm,
        "revert" => ConfirmCommand::Revert,
        other => {
            return Err(ApiError::bad_request(format!(
                "unknown confirm command `{other}`"
            )));
        }
    };

    state
        .daemon
        .call_raw(DaemonRequest::ConfirmPendingConfig(command))
        .await?;

    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct FanBody {
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<FanControlMode>,
    #[serde(default)]
    pub static_speed: Option<f32>,
    #[serde(default)]
    pub curve: Option<FanCurveMap>,
    #[serde(default)]
    pub pmfw: PmfwOptions,
    #[serde(default)]
    pub spindown_delay_ms: Option<u64>,
    #[serde(default)]
    pub change_threshold: Option<u64>,
}

pub async fn set_fan(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<FanBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetFanControl(FanOptions {
            id: &id,
            enabled: body.enabled,
            mode: body.mode,
            static_speed: body.static_speed,
            curve: body.curve,
            pmfw: body.pmfw,
            spindown_delay_ms: body.spindown_delay_ms,
            change_threshold: body.change_threshold,
        }))
        .await?;

    Ok(auto_revert_ms(value))
}

#[derive(Deserialize)]
pub struct PowerCapBody {
    pub cap: Option<f64>,
}

pub async fn set_power_cap(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PowerCapBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetPowerCap {
            id: &id,
            cap: body.cap,
        })
        .await?;

    Ok(auto_revert_ms(value))
}

#[derive(Deserialize)]
pub struct PerformanceLevelBody {
    pub level: PerformanceLevel,
}

pub async fn set_performance_level(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PerformanceLevelBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetPerformanceLevel {
            id: &id,
            performance_level: body.level,
        })
        .await?;

    Ok(auto_revert_ms(value))
}

pub async fn set_clocks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(commands): Json<Vec<SetClocksCommand>>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::BatchSetClocksValue {
            id: &id,
            commands,
        })
        .await?;

    Ok(auto_revert_ms(value))
}

#[derive(Deserialize)]
pub struct PowerProfileModeBody {
    pub index: Option<u16>,
    #[serde(default)]
    pub custom_heuristics: Vec<Vec<Option<i32>>>,
}

pub async fn set_power_profile_mode(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PowerProfileModeBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetPowerProfileMode {
            id: &id,
            index: body.index,
            custom_heuristics: body.custom_heuristics,
        })
        .await?;

    Ok(auto_revert_ms(value))
}

#[derive(Deserialize)]
pub struct PowerStatesBody {
    pub kind: PowerLevelKind,
    pub states: Vec<u8>,
}

pub async fn set_power_states(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PowerStatesBody>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;

    let value: u64 = state
        .daemon
        .call_typed(DaemonRequest::SetEnabledPowerStates {
            id: &id,
            kind: body.kind,
            states: body.states,
        })
        .await?;

    Ok(auto_revert_ms(value))
}

pub async fn dump_vbios(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    ensure_allowed(&state, &id)?;

    let value = state
        .daemon
        .call_raw_timeout(DaemonRequest::VbiosDump { id: &id }, VBIOS_TIMEOUT)
        .await?;

    // The daemon reports the VBIOS as a JSON byte array (it is gzipped on AMD).
    let bytes: Vec<u8> = serde_json::from_value(value)
        .map_err(|err| ApiError::internal(format!("unexpected VBIOS payload: {err}")))?;

    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"vbios-{id}.bin\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn detach(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    state
        .daemon
        .call_raw_timeout(DaemonRequest::DetachGpu { id: &id }, SNAPSHOT_TIMEOUT)
        .await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn reattach(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_allowed(&state, &id)?;
    state
        .daemon
        .call_raw_timeout(DaemonRequest::ReattachGpu { id: &id }, SNAPSHOT_TIMEOUT)
        .await?;
    Ok(Json(json!({"ok": true})))
}

/// Map a daemon "not available on this hardware" style error to 501 so the UI can hide controls
/// instead of shouting at the user.
pub fn is_unsupported(err: &DaemonError) -> bool {
    matches!(err, DaemonError::Daemon(message) if message.contains("not supported") || message.contains("not available"))
}
