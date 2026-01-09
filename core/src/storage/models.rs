//! Data models for job storage

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Job status enum matching protobuf definition
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobStatus {
    Pending,
    Running,
    Success,
    Failed,
    Dead,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Pending => "PENDING",
            JobStatus::Running => "RUNNING",
            JobStatus::Success => "SUCCESS",
            JobStatus::Failed => "FAILED",
            JobStatus::Dead => "DEAD",
            JobStatus::Cancelled => "CANCELLED",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "PENDING" => Some(JobStatus::Pending),
            "RUNNING" => Some(JobStatus::Running),
            "SUCCESS" => Some(JobStatus::Success),
            "FAILED" => Some(JobStatus::Failed),
            "DEAD" => Some(JobStatus::Dead),
            "CANCELLED" => Some(JobStatus::Cancelled),
            _ => None,
        }
    }
}

/// Backoff strategy for retries
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackoffStrategy {
    Fixed,
    Exponential,
    Linear,
}

impl Default for BackoffStrategy {
    fn default() -> Self {
        BackoffStrategy::Exponential
    }
}

/// Job options for retry behavior
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobOptions {
    #[serde(default = "default_max_attempts")]
    pub max_attempts: i32,
    #[serde(default)]
    pub backoff: BackoffStrategy,
    #[serde(default = "default_initial_delay")]
    pub initial_delay_ms: i32,
    #[serde(default = "default_max_delay")]
    pub max_delay_ms: i32,
    #[serde(default = "default_timeout")]
    pub timeout_ms: i32,
    #[serde(default = "default_jitter")]
    pub jitter: f32,
}

fn default_max_attempts() -> i32 {
    3
}
fn default_initial_delay() -> i32 {
    1000
}
fn default_max_delay() -> i32 {
    60000
}
fn default_timeout() -> i32 {
    30000
}
fn default_jitter() -> f32 {
    0.1
}

impl Default for JobOptions {
    fn default() -> Self {
        Self {
            max_attempts: default_max_attempts(),
            backoff: BackoffStrategy::default(),
            initial_delay_ms: default_initial_delay(),
            max_delay_ms: default_max_delay(),
            timeout_ms: default_timeout(),
            jitter: default_jitter(),
        }
    }
}

/// A persisted job
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalJob {
    pub id: String,
    pub name: String,
    pub args: Vec<u8>,
    pub options: JobOptions,
    pub status: JobStatus,
    pub attempt: i32,
    pub created_at: DateTime<Utc>,
    pub scheduled_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub result: Option<Vec<u8>>,
    pub worker_id: Option<String>,
    pub idempotency_key: Option<String>,
}

/// Input for creating a new job
#[derive(Debug, Clone)]
pub struct NewJob {
    pub name: String,
    pub args: Vec<u8>,
    pub options: JobOptions,
    pub idempotency_key: Option<String>,
}

impl NewJob {
    /// Create a InternalJob from NewJob with generated ID and timestamps
    pub fn into_job(self) -> InternalJob {
        let now = Utc::now();
        InternalJob {
            id: Uuid::new_v4().to_string(),
            name: self.name,
            args: self.args,
            options: self.options,
            status: JobStatus::Pending,
            attempt: 0,
            created_at: now,
            scheduled_at: now, // Run immediately
            started_at: None,
            completed_at: None,
            error: None,
            result: None,
            worker_id: None,
            idempotency_key: self.idempotency_key,
        }
    }
}

/// Result of job execution
#[derive(Debug, Clone)]
pub enum JobResult {
    Success { return_value: Option<Vec<u8>> },
    Failed { error: String, should_retry: bool },
}

/// Filter for listing jobs
#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    pub statuses: Vec<JobStatus>,
    pub names: Vec<String>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    pub order_by: Option<String>,
    pub ascending: bool,
}
