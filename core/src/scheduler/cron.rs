//! Cron Scheduler for Reseolio
//!
//! This module provides a cron-based scheduling loop that:
//! 1. Polls for due schedules (where next_run_at <= now)
//! 2. Creates a job for each due schedule
//! 3. Updates the schedule's next_run_at to the next occurrence
//!
//! The scheduler uses idempotent job creation to prevent duplicates in
//! multi-node deployments.

use crate::storage::Storage;
use chrono::Utc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tracing::{debug, error, info};

/// The cron scheduler that triggers scheduled jobs
#[derive(Clone)]
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

            // 1. Process due schedules
            match self.storage.trigger_due_schedules().await {
                Ok(count) => {
                    if count > 0 {
                        debug!("Triggered {} schedules", count);
                    }
                }
                Err(e) => {
                    error!("Error processing due schedules: {}", e);
                }
            }

            // 2. Calculate smart sleep time
            let sleep_duration = match self.storage.get_next_schedule_time().await {
                Ok(Some(next_run)) => {
                    let now = Utc::now();
                    if next_run <= now {
                        // We are already late, don't sleep (or minimum sleep)
                        Duration::from_millis(100)
                    } else {
                        // Sleep until next run, but cap at poll_interval (e.g. 10s or 60s)
                        // This ensures we eventually wake up to pick up NEWLY INSERTED schedules
                        let diff = (next_run - now).to_std().unwrap_or(Duration::from_secs(1));

                        // Rule: If next job is > 1s away, sleep optimally.
                        // Cap at configured poll_interval to catch new schedules.
                        diff.min(self.poll_interval).max(Duration::from_millis(100))
                    }
                }
                Ok(None) => self.poll_interval, // No active schedules? Sleep max interval
                Err(e) => {
                    error!("Error getting next schedule time: {}", e);
                    self.poll_interval
                }
            };

            // debug!("Cron scheduler sleeping for {}ms", sleep_duration.as_millis());

            // Wait for next poll or shutdown signal
            tokio::select! {
                _ = tokio::time::sleep(sleep_duration) => {},
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{NewSchedule, ScheduleStatus, SqliteStorage};
    use chrono::TimeZone;

    #[tokio::test]
    async fn test_cron_logic_flow() {
        let storage = SqliteStorage::in_memory().await.unwrap();
        let notify = Arc::new(Notify::new());

        // 1. Create a schedule that is due (1 minute ago)
        let now = Utc::now();
        let one_min_ago = now - chrono::Duration::minutes(1);

        // We manually force a past next_run_at to simulate a due schedule
        // Note: NewSchedule automatically calculates next_run_at based on cron string,
        // so we need to "hack" it or wait?
        // Actually, NewSchedule calculates next_run based on NOW.
        // So if we create "* * * * * *", it will be due in ~1s.
        // Let's Insert then Update to force it to be due.

        let schedule = storage
            .create_schedule(NewSchedule {
                name: "test-schedule".to_string(),
                cron_expression: "* * * * * *".to_string(), // Every second
                timezone: None,
                handler_options: None,
                args: None,
            })
            .await
            .unwrap();

        // Manually update to make it due NOW
        // We use a raw query or just rely on the fact that if we wait 1s it becomes due.
        // But for deterministic tests, let's use raw SQL to backdate it.
        // Wait, SqliteStorage::in_memory returns the struct, accessing inner conn is hard if not pub.
        // Accessing via storage trait... existing update_schedule doesn't let us set next_run_at arbitrarily.
        // Let's just create one that triggers every second and wait 1.1s.

        tokio::time::sleep(Duration::from_millis(1100)).await;

        // 2. Trigger due schedules
        let count = storage.trigger_due_schedules().await.unwrap();
        assert_eq!(count, 1, "Should have triggered 1 schedule");

        // 3. Verify Job Created
        let (jobs, _) = storage.list_jobs(Default::default()).await.unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].name, "test-schedule");
        assert_eq!(jobs[0].attempt, 0);

        // 4. Verify Schedule Updated
        let updated_schedule = storage.get_schedule(&schedule.id).await.unwrap().unwrap();
        assert!(updated_schedule.next_run_at > now);
        assert_eq!(updated_schedule.last_run_at.is_some(), true);
    }

    #[tokio::test]
    async fn test_smart_sleeping_logic() {
        let storage = SqliteStorage::in_memory().await.unwrap();

        // No schedules
        let next = storage.get_next_schedule_time().await.unwrap();
        assert!(next.is_none());

        // Add a schedule
        let _ = storage
            .create_schedule(NewSchedule {
                name: "future-schedule".to_string(),
                cron_expression: "0 0 1 1 *".to_string(), // Jan 1st (far future relative to test usually)
                timezone: None,
                handler_options: None,
                args: None,
            })
            .await
            .unwrap();

        let next = storage.get_next_schedule_time().await.unwrap();
        assert!(next.is_some());
    }

    #[tokio::test]
    async fn test_scheduler_shutdown() {
        let storage = SqliteStorage::in_memory().await.unwrap();
        let notify = Arc::new(Notify::new());
        let scheduler = CronScheduler::new(storage, notify.clone())
            .with_poll_interval(Duration::from_millis(100));

        let scheduler_clone = scheduler.clone();
        let handle = tokio::spawn(async move {
            scheduler_clone.run().await;
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        scheduler.shutdown();

        // Should finish quickly
        let result = tokio::time::timeout(Duration::from_secs(1), handle).await;
        assert!(result.is_ok(), "Scheduler did not shut down in time");
    }
}
