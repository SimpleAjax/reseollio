use reseolio::{BackoffStrategy, DurableOptions, Reseolio, ReseolioConfig};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let client = Reseolio::new(ReseolioConfig {
        storage: Some("sqlite://./reseolio.db".to_string()),
        ..Default::default()
    });

    client.start().await?;

    // Counter to track attempts
    let attempt_count = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&attempt_count);

    // Flaky function that fails first 2 attempts
    // Note: Since durable functions must return serializable types,
    // we handle errors by returning a status string instead of using Result
    let flaky_task = client.durable(
        "test:flaky:process",
        move |_: ()| {
            let c = Arc::clone(&counter);
            async move {
                let attempt = c.fetch_add(1, Ordering::SeqCst) + 1;
                println!("🔄 Attempt {}", attempt);

                if attempt < 3 {
                    // In a real scenario, you might want to panic here to trigger a retry
                    // Or return an error status that the caller can check
                    panic!("Simulated failure (attempt {})", attempt);
                }

                format!("Success after {} attempts!", attempt)
            }
        },
        DurableOptions {
            max_attempts: Some(5),
            backoff: Some(BackoffStrategy::Exponential),
            initial_delay_ms: Some(100),
            timeout_ms: Some(5000),
            ..Default::default()
        },
    );

    let handle = flaky_task.call(()).await?;
    println!("✅ Job enqueued: {}", handle.job_id());

    match handle.result().await {
        Ok(result) => {
            let final_attempts = attempt_count.load(Ordering::SeqCst);
            println!("✨ {}", result);
            println!("📊 Total attempts: {}", final_attempts);
        }
        Err(e) => {
            println!("❌ Job failed: {}", e);
        }
    }

    client.stop().await?;

    Ok(())
}
