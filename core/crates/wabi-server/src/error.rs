//! Application error types

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Too many requests: {0}")]
    #[allow(dead_code)]
    TooManyRequests(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Not found: {0}")]
    #[allow(dead_code)]
    NotFound(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Database error: {0}")]
    #[allow(dead_code)]
    Database(String),

    #[error("Bcrypt error: {0}")]
    Bcrypt(#[from] bcrypt::BcryptError),

    #[error("JWT error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Anyhow error: {0}")]
    Anyhow(#[from] anyhow::Error),

    #[error("HTTP client error: {0}")]
    Reqwest(#[from] reqwest::Error),

    #[error("WDB error: {0}")]
    Wdb(#[from] wabidb::error::WabiError),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Internal errors may carry host paths, database records or upstream
        // URLs with credentials. Preserve diagnostics in server logs only.
        let error_type = match &self {
            Self::BadRequest(_) => "BadRequest",
            Self::Unauthorized(_) => "Unauthorized",
            Self::TooManyRequests(_) => "TooManyRequests",
            Self::Forbidden(_) => "Forbidden",
            Self::NotFound(_) => "NotFound",
            Self::Conflict(_) => "Conflict",
            Self::Jwt(_) => "Jwt",
            Self::Wdb(wabidb::error::WabiError::Validation { command, .. })
                if matches!(
                    command.as_str(),
                    "room_owner_precondition" | "user_identity"
                ) =>
            {
                "Conflict"
            }
            _ => "Internal",
        };
        if error_type == "Internal" {
            tracing::error!(error = ?self, "request failed internally");
        }
        let (status, error_message) = match &self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            AppError::TooManyRequests(msg) => (StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            AppError::Jwt(msg) => (StatusCode::UNAUTHORIZED, msg.to_string()),
            AppError::Wdb(wabidb::error::WabiError::Validation { command, .. })
                if command == "user_identity" =>
            {
                (
                    StatusCode::CONFLICT,
                    "Account changed or username is already in use".into(),
                )
            }
            AppError::Wdb(wabidb::error::WabiError::Validation { command, .. })
                if command == "room_owner_precondition" =>
            {
                (
                    StatusCode::CONFLICT,
                    "This room changed owners before the write could be committed".into(),
                )
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error".into(),
            ),
        };

        let body = Json(json!({
            "error": error_message,
            "type": error_type,
        }));

        (status, body).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_room_owner_is_an_http_conflict() {
        let error = AppError::Wdb(wabidb::error::WabiError::Validation {
            command: "room_owner_precondition".into(),
            reason: "changed before commit".into(),
        });
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn internal_errors_do_not_publish_host_paths_records_or_credentials() {
        const PRIVATE: &str =
            "fixture-private-detail /host/private/key https://upstream.invalid/?token=fixture";
        for error in [
            AppError::Internal(PRIVATE.into()),
            AppError::Database(PRIVATE.into()),
            AppError::Io(std::io::Error::other(PRIVATE)),
            AppError::Anyhow(anyhow::anyhow!(PRIVATE)),
            AppError::Wdb(wabidb::error::WabiError::InternalInvariantViolated {
                invariant: PRIVATE.into(),
            }),
        ] {
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                body,
                json!({"error": "Internal server error", "type": "Internal"})
            );
        }
        let response = AppError::BadRequest("Choose a valid channel".into()).into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Choose a valid channel");
        assert_eq!(body["type"], "BadRequest");
    }
}
