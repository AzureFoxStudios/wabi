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
        let (status, error_message) = match &self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            AppError::TooManyRequests(msg) => (StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            AppError::Database(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            AppError::Bcrypt(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()),
            AppError::Jwt(msg) => (StatusCode::UNAUTHORIZED, msg.to_string()),
            AppError::Io(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()),
            AppError::Anyhow(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()),
            AppError::Reqwest(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()),
            AppError::Wdb(msg) => (StatusCode::INTERNAL_SERVER_ERROR, format!("wdb: {msg}")),
        };

        let body = Json(json!({
            "error": error_message,
            "type": format!("{:?}", self),
        }));

        (status, body).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
