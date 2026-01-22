use crate::{error::Result, types::*, ReseolioError};
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

/// Handle to a running or completed job
pub struct JobHandle<T = serde_json::Value> {
    job_id: String,
    client: Arc<crate::client::ReseolioInner>,
    _phantom: PhantomData<T>,
}

impl<T> JobHandle<T>
where
    T: serde::de::DeserializeOwned,
{
    pub(crate) fn new(job_id: String, client: Arc<crate::client::ReseolioInner>) -> Self {
        Self {
            job_id,
            client,
            _phantom: PhantomData,
        }
    }

    /// Get the job ID
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// Get current job status
    pub async fn status(&self) -> Result<JobStatus> {
        let job = self.client.get_job(&self.job_id).await?;
        Ok(job.status)
    }

    /// Wait for the job result
    ///
    /// Uses push-based subscription (no polling) for efficient result notification.
    pub async fn result(&self) -> Result<T> {
        self.result_with_timeout(None).await
    }

    /// Wait for the job result with optional timeout
    pub async fn result_with_timeout(&self, timeout: Option<Duration>) -> Result<T> {
        // Check for cached result first
        if let Some(cached) = self.client.try_get_result(&self.job_id).await {
            return match cached {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|e| ReseolioError::SerializationError(e.to_string())),
                Err(err_msg) => Err(ReseolioError::JobFailed(err_msg)),
            };
        }

        // Subscribe and wait
        let result = match timeout {
            Some(duration) => {
                tokio::time::timeout(duration, self.client.subscribe_to_job(&self.job_id))
                    .await
                    .map_err(|_| ReseolioError::JobTimeout(duration.as_millis() as u64))??
                    .map_err(ReseolioError::JobFailed)?
            }
            None => self
                .client
                .subscribe_to_job(&self.job_id)
                .await?
                .map_err(ReseolioError::JobFailed)?,
        };

        serde_json::from_slice(&result).map_err(Into::into)
    }

    /// Cancel the job if still pending
    pub async fn cancel(&self) -> Result<bool> {
        self.client.cancel_job(&self.job_id).await
    }

    /// Get full job details
    pub async fn details(&self) -> Result<Job> {
        self.client.get_job(&self.job_id).await
    }
}
