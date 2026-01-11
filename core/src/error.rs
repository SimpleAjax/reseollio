//! Error types for Reseolio Core

use thiserror::Error;

/// Core error types
#[derive(Error, Debug)]
pub enum ReseolioError {
    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),

    #[error("Scheduler error: {0}")]
    Scheduler(String),

    #[error("Job not found: {0}")]
    JobNotFound(String),

    #[error("Invalid job state transition: {from} -> {to}")]
    InvalidStateTransition { from: String, to: String },

    #[error("Job already exists with idempotency key: {0}")]
    DuplicateJob(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Storage-specific errors
#[derive(Error, Debug)]
pub enum StorageError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Connection pool error: {0}")]
    Pool(String),

    #[cfg(feature = "postgres")]
    #[error("Postgres error: {0}")]
    Postgres(#[from] sqlx::Error),
}

pub type Result<T> = std::result::Result<T, ReseolioError>;
