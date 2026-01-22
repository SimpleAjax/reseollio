use crate::{error::Result, job::JobHandle, schedule::ScheduleHandle, types::*};
use std::marker::PhantomData;
use std::sync::Arc;

/// A durable function that returns a JobHandle when called
pub struct DurableFunction<Args, Ret> {
    name: String,
    options: DurableOptions,
    client: Arc<crate::client::ReseolioInner>,
    _phantom: PhantomData<(Args, Ret)>,
}

impl<Args, Ret> DurableFunction<Args, Ret>
where
    Args: serde::Serialize + Send + 'static,
    Ret: serde::de::DeserializeOwned + Send + 'static,
{
    pub(crate) fn new(
        name: String,
        options: DurableOptions,
        client: Arc<crate::client::ReseolioInner>,
    ) -> Self {
        Self {
            name,
            options,
            client,
            _phantom: PhantomData,
        }
    }

    /// Get the function name
    pub fn function_name(&self) -> &str {
        &self.name
    }

    /// Get the default options
    pub fn options(&self) -> &DurableOptions {
        &self.options
    }

    /// Call the durable function
    pub async fn call(&self, args: Args) -> Result<JobHandle<Ret>> {
        self.call_with_options(args, JobOptions::default()).await
    }

    /// Call with custom options
    pub async fn call_with_options(
        &self,
        args: Args,
        options: JobOptions,
    ) -> Result<JobHandle<Ret>> {
        let merged_options = self.merge_options(options);
        let job_id = self
            .client
            .enqueue(&self.name, &args, merged_options)
            .await?;
        Ok(JobHandle::new(job_id, Arc::clone(&self.client)))
    }

    /// Schedule this function with a cron expression
    pub async fn schedule(
        &self,
        schedule_options: ScheduleOptions,
        args: Args,
    ) -> Result<ScheduleHandle> {
        (&self.client)
            .create_schedule(&self.name, schedule_options, &args)
            .await
    }

    /// Schedule every minute
    pub async fn every_minute(&self, args: Args) -> Result<ScheduleHandle> {
        self.schedule(
            ScheduleOptions {
                cron: "* * * * *".to_string(),
                timezone: None,
                handler_options: None,
            },
            args,
        )
        .await
    }

    /// Schedule hourly
    pub async fn hourly(&self, args: Args) -> Result<ScheduleHandle> {
        self.schedule(
            ScheduleOptions {
                cron: "0 * * * *".to_string(),
                timezone: None,
                handler_options: None,
            },
            args,
        )
        .await
    }

    /// Schedule daily at specific hour
    pub async fn daily(&self, hour: u8, args: Args) -> Result<ScheduleHandle> {
        self.schedule(
            ScheduleOptions {
                cron: format!("0 {} * * *", hour),
                timezone: None,
                handler_options: None,
            },
            args,
        )
        .await
    }

    /// Schedule weekly
    pub async fn weekly(&self, day_of_week: u8, hour: u8, args: Args) -> Result<ScheduleHandle> {
        self.schedule(
            ScheduleOptions {
                cron: format!("0 {} * * {}", hour, day_of_week + 1),
                timezone: None,
                handler_options: None,
            },
            args,
        )
        .await
    }

    fn merge_options(&self, execution_options: JobOptions) -> JobOptions {
        JobOptions {
            max_attempts: execution_options.max_attempts.or(self.options.max_attempts),
            backoff: execution_options
                .backoff
                .or_else(|| self.options.backoff.clone()),
            initial_delay_ms: execution_options
                .initial_delay_ms
                .or(self.options.initial_delay_ms),
            max_delay_ms: execution_options.max_delay_ms.or(self.options.max_delay_ms),
            timeout_ms: execution_options.timeout_ms.or(self.options.timeout_ms),
            jitter: execution_options.jitter.or(self.options.jitter),
            idempotency_key: execution_options.idempotency_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_options_merge() {
        let durable_opts = DurableOptions {
            max_attempts: Some(5),
            timeout_ms: Some(10000),
            ..Default::default()
        };

        // Create a mock client (this won't actually be used in the test)
        // In real tests, we'd use an actual client or mock
        let func = DurableFunction::<(), ()> {
            name: "test".to_string(),
            options: durable_opts.clone(),
            client: Arc::new(crate::client::ReseolioInner::default_for_test()),
            _phantom: PhantomData,
        };

        let exec_opts = JobOptions {
            max_attempts: Some(3), // Override
            idempotency_key: Some("key123".to_string()),
            ..Default::default()
        };

        let merged = func.merge_options(exec_opts);

        assert_eq!(merged.max_attempts, Some(3)); // From execution
        assert_eq!(merged.timeout_ms, Some(10000)); // From durable
        assert_eq!(merged.idempotency_key, Some("key123".to_string()));
    }
}
