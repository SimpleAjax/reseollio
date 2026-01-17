//! Cron Scheduler for Reseolio
//!
//! This module provides a cron-based scheduling loop that:
//! 1. Polls for due schedules (where next_run_at <= now)
//! 2. Creates a job for each due schedule
//! 3. Updates the schedule's next_run_at to the next occurrence
//!
//! The scheduler uses idempotent job creation to prevent duplicates in
//! multi-node deployments.

use crate::error::Result;
use crate::storage::{next_cron_time, NewJob, Schedule, Storage};
use chrono::Utc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tracing::{debug, error, info};

/// The cron scheduler that triggers scheduled jobs
pub struct CronScheduler<S: Storage> {
    storage: S,
    /// Notify channel for shutdown
    shutdown_notify: Arc<Notify>,
    /// Shutdown flag
    shutdown: Arc<AtomicBool>,
    /// Poll interval for checking due schedules
    poll_interval: Duration,
}

impl<S: Storage> CronScheduler<S> {
    /// Create a new cron scheduler
    pub fn new(storage: S, shutdown_notify: Arc<Notify>) -> Self {
        Self {
            storage,
            shutdown_notify,
            shutdown: Arc::new(AtomicBool::new(false)),
            poll_interval: Duration::from_secs(1),
        }
    }

    /// Set the poll interval
    pub fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    /// Run the cron scheduler loop
    ///
    /// This polls for due schedules and creates jobs for them.
    pub async fn run(&self) {
        info!(
            "Starting cron scheduler (poll_interval={}ms)",
            self.poll_interval.as_millis()
        );

        loop {
            // Check for shutdown
            if self.shutdown.load(Ordering::Relaxed) {
                info!("Cron scheduler shutting down");
                break;
            }

            // Process due schedules
            if let Err(e) = self.process_due_schedules().await {
                error!("Error processing due schedules: {}", e);
            }

            // Wait for next poll or shutdown signal
            tokio::select! {
                _ = tokio::time::sleep(self.poll_interval) => {},
                _ = self.shutdown_notify.notified() => {
                    // Check if it's a shutdown signal or just a notification
                    if self.shutdown.load(Ordering::Relaxed) {
                        info!("Cron scheduler received shutdown signal");
                        break;
                    }
                }
            }
        }
    }

    /// Signal the scheduler to shut down
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.shutdown_notify.notify_one();
    }

    /// Process all due schedules
    async fn process_due_schedules(&self) -> Result<()> {
        let due_schedules = self.storage.get_due_schedules().await?;

        if due_schedules.is_empty() {
            return Ok(());
        }

        debug!("Found {} due schedule(s) to trigger", due_schedules.len());

        for schedule in due_schedules {
            if let Err(e) = self.trigger_schedule(&schedule).await {
                error!(
                    "Failed to trigger schedule {} ({}): {}",
                    schedule.id, schedule.name, e
                );
            }
        }

        Ok(())
    }

    /// Trigger a single schedule - create a job and update next_run_at
    async fn trigger_schedule(&self, schedule: &Schedule) -> Result<()> {
        info!("Triggering schedule: {} ({})", schedule.id, schedule.name);

        // Create the idempotency key for this schedule run
        // Format: "{schedule_id}:{next_run_at_timestamp}"
        let schedule_run_id = format!("{}:{}", schedule.id, schedule.next_run_at.timestamp());

        // Create the job
        let new_job = NewJob {
            name: schedule.name.clone(),
            args: vec![], // Empty args - the handler knows what to do
            options: schedule.handler_options.clone(),
            idempotency_key: Some(schedule_run_id.clone()),
        };

        match self
            .storage
            .insert_scheduled_job(new_job, &schedule.id, &schedule_run_id)
            .await
        {
            Ok((job, was_deduplicated)) => {
                if was_deduplicated {
                    debug!(
                        "Job for schedule {} already existed (idempotent)",
                        schedule.name
                    );
                } else {
                    info!("Created job {} for schedule {}", job.id, schedule.name);
                }
            }
            Err(e) => {
                error!("Failed to create job for schedule {}: {}", schedule.name, e);
                return Err(e);
            }
        }

        // Calculate next run time
        let next_run = next_cron_time(&schedule.cron_expression, &schedule.timezone, Utc::now())?;

        // Update the schedule's next_run_at
        self.storage
            .update_schedule_after_trigger(&schedule.id, next_run)
            .await?;

        debug!(
            "Schedule {} next run: {}",
            schedule.name,
            next_run.format("%Y-%m-%d %H:%M:%S UTC")
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStorage;

    #[tokio::test]
    async fn test_cron_scheduler_creation() {
        let storage = SqliteStorage::in_memory().await.unwrap();
        let notify = Arc::new(Notify::new());

        let scheduler = CronScheduler::new(storage, notify.clone())
            .with_poll_interval(Duration::from_millis(100));

        // Just verify creation works
        assert_eq!(scheduler.poll_interval, Duration::from_millis(100));
    }
}
