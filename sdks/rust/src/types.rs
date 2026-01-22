use serde::{Deserialize, Serialize};

/// Backoff strategy for retries
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackoffStrategy {
    #[default]
    Exponential,
    Linear,
    Fixed,
}

impl BackoffStrategy {
    pub fn as_str(&self) -> &str {
        match self {
            BackoffStrategy::Exponential => "exponential",
            BackoffStrategy::Linear => "linear",
            BackoffStrategy::Fixed => "fixed",
        }
    }
}

/// Job status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Running,
    Success,
    Failed,
    Dead,
    Cancelled,
}

impl From<i32> for JobStatus {
    fn from(status: i32) -> Self {
        match status {
            1 => JobStatus::Pending,
            2 => JobStatus::Running,
            3 => JobStatus::Success,
            4 => JobStatus::Failed,
            5 => JobStatus::Dead,
            6 => JobStatus::Cancelled,
            _ => JobStatus::Pending,
        }
    }
}

/// Schedule status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleStatus {
    Active,
    Paused,
    Deleted,
}

impl From<i32> for ScheduleStatus {
    fn from(status: i32) -> Self {
        match status {
            1 => ScheduleStatus::Active,
            2 => ScheduleStatus::Paused,
            3 => ScheduleStatus::Deleted,
            _ => ScheduleStatus::Active,
        }
    }
}

/// Options for job execution
#[derive(Debug, Clone, Default)]
pub struct JobOptions {
    /// Maximum retry attempts (default: 3)
    pub max_attempts: Option<u32>,
    /// Backoff strategy (default: exponential)
    pub backoff: Option<BackoffStrategy>,
    /// Initial delay between retries in ms (default: 1000)
    pub initial_delay_ms: Option<u32>,
    /// Maximum delay cap in ms (default: 60000)
    pub max_delay_ms: Option<u32>,
    /// Per-attempt timeout in ms (default: 30000)
    pub timeout_ms: Option<u32>,
    /// Jitter factor 0.0-1.0 (default: 0.1)
    pub jitter: Option<f32>,
    /// Idempotency key for deduplication
    pub idempotency_key: Option<String>,
}

/// Options for durable function registration (no idempotency key)
#[derive(Debug, Clone, Default)]
pub struct DurableOptions {
    pub max_attempts: Option<u32>,
    pub backoff: Option<BackoffStrategy>,
    pub initial_delay_ms: Option<u32>,
    pub max_delay_ms: Option<u32>,
    pub timeout_ms: Option<u32>,
    pub jitter: Option<f32>,
}

impl From<DurableOptions> for JobOptions {
    fn from(opts: DurableOptions) -> Self {
        JobOptions {
            max_attempts: opts.max_attempts,
            backoff: opts.backoff,
            initial_delay_ms: opts.initial_delay_ms,
            max_delay_ms: opts.max_delay_ms,
            timeout_ms: opts.timeout_ms,
            jitter: opts.jitter,
            idempotency_key: None,
        }
    }
}

/// Options for creating a schedule
#[derive(Debug, Clone)]
pub struct ScheduleOptions {
    /// Cron expression (e.g., "0 8 * * *")
    pub cron: String,
    /// IANA timezone (default: "UTC")
    pub timezone: Option<String>,
    /// Options applied to triggered jobs
    pub handler_options: Option<JobOptions>,
}

/// Job details
#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub args: Vec<u8>,
    pub attempt: u32,
    pub deadline_ms: i64,
    pub status: JobStatus,
    pub error: Option<String>,
    pub result: Option<Vec<u8>>,
    pub created_at: i64,
    pub scheduled_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub max_attempts: u32,
}

/// Schedule details
#[derive(Debug, Clone)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub status: ScheduleStatus,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub handler_options: Option<JobOptions>,
    pub args: Option<Vec<u8>>,
}

/// Filter for listing schedules
#[derive(Debug, Clone, Default)]
pub struct ListSchedulesFilter {
    pub status: Option<ScheduleStatus>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Result of listing schedules
#[derive(Debug, Clone)]
pub struct ListSchedulesResult {
    pub schedules: Vec<Schedule>,
    pub total: u32,
}

/// Options for updating a schedule
#[derive(Debug, Clone, Default)]
pub struct UpdateScheduleOptions {
    pub cron: Option<String>,
    pub timezone: Option<String>,
    pub handler_options: Option<JobOptions>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_job_status_conversion() {
        assert_eq!(JobStatus::from(1), JobStatus::Pending);
        assert_eq!(JobStatus::from(3), JobStatus::Success);
        assert_eq!(JobStatus::from(5), JobStatus::Dead);
    }

    #[test]
    fn test_schedule_status_conversion() {
        assert_eq!(ScheduleStatus::from(1), ScheduleStatus::Active);
        assert_eq!(ScheduleStatus::from(2), ScheduleStatus::Paused);
    }

    #[test]
    fn test_backoff_strategy_as_str() {
        assert_eq!(BackoffStrategy::Exponential.as_str(), "exponential");
        assert_eq!(BackoffStrategy::Linear.as_str(), "linear");
        assert_eq!(BackoffStrategy::Fixed.as_str(), "fixed");
    }
}
