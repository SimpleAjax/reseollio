use crate::{error::Result, types::*};
use chrono::{DateTime, Utc};
use std::sync::Arc;

/// Handle to a cron schedule
pub struct ScheduleHandle {
    id: String,
    name: String,
    client: Arc<crate::client::ReseolioInner>,
}

impl ScheduleHandle {
    pub(crate) fn new(id: String, name: String, client: Arc<crate::client::ReseolioInner>) -> Self {
        Self { id, name, client }
    }

    /// Get schedule ID
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get schedule name
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Get current schedule details
    pub async fn details(&self) -> Result<Schedule> {
        self.client.get_schedule(&self.id).await
    }

    /// Get current status
    pub async fn status(&self) -> Result<ScheduleStatus> {
        let schedule = self.details().await?;
        Ok(schedule.status)
    }

    /// Pause the schedule
    pub async fn pause(&self) -> Result<Schedule> {
        self.client.pause_schedule(&self.id).await
    }

    /// Resume the schedule
    pub async fn resume(&self) -> Result<Schedule> {
        self.client.resume_schedule(&self.id).await
    }

    /// Update schedule options
    pub async fn update(&self, options: UpdateScheduleOptions) -> Result<Schedule> {
        self.client.update_schedule(&self.id, options).await
    }

    /// Delete (soft-delete) the schedule
    pub async fn delete(&self) -> Result<bool> {
        self.client.delete_schedule(&self.id).await
    }

    /// Get next run time
    pub async fn next_run_at(&self) -> Result<DateTime<Utc>> {
        let schedule = self.details().await?;
        Ok(DateTime::from_timestamp_millis(schedule.next_run_at).unwrap_or_default())
    }

    /// Get last run time
    pub async fn last_run_at(&self) -> Result<Option<DateTime<Utc>>> {
        let schedule = self.details().await?;
        Ok(schedule
            .last_run_at
            .map(|ts| DateTime::from_timestamp_millis(ts).unwrap_or_default()))
    }
}
