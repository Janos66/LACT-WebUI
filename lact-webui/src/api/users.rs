//! Account management API. Every handler here is administrator-only.

use super::{AppState, AuthUser};
use crate::{
    error::{ApiError, ApiResult},
    users::Role,
};
use axum::{
    Json,
    extract::{Extension, Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};

fn ensure_admin(auth: &AuthUser) -> ApiResult<()> {
    if auth.role.is_admin() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "administrator role required",
        ))
    }
}

pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    ensure_admin(&auth)?;

    let users: Vec<Value> = state
        .users
        .list()
        .await
        .into_iter()
        .map(|user| {
            json!({
                "username": user.username,
                "role": user.role,
                "created_at": user.created_at,
                "disabled": user.disabled,
                "you": user.username == auth.username,
            })
        })
        .collect();

    Ok(Json(json!({ "users": users })))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub role: Option<Role>,
}

pub async fn create(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Json<Value>> {
    ensure_admin(&auth)?;

    let role = body.role.unwrap_or(Role::Operator);

    state
        .users
        .create(body.username.trim(), &body.password, role)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(name): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<Value>> {
    ensure_admin(&auth)?;

    let mut credentials_changed = false;

    if let Some(role) = body.role {
        state
            .users
            .set_role(&name, role)
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
    }

    if let Some(password) = body.password {
        state
            .users
            .set_password(&name, &password)
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        credentials_changed = true;
    }

    if let Some(disabled) = body.disabled {
        state
            .users
            .set_disabled(&name, disabled)
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if disabled {
            credentials_changed = true;
        }
    }

    // Changing a password or disabling an account must immediately revoke its sessions.
    if credentials_changed {
        state.sessions.invalidate_user(&name).await;
    }

    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    ensure_admin(&auth)?;

    state
        .users
        .remove(&name)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;

    state.sessions.invalidate_user(&name).await;

    Ok(Json(json!({ "ok": true })))
}
