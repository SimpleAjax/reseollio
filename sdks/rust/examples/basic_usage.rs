use reseolio::{DurableOptions, Reseolio, ReseolioConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct EmailResult {
    sent: bool,
    timestamp: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Create client
    let client = Reseolio::new(ReseolioConfig {
        storage: Some("sqlite://./reseolio.db".to_string()),
        ..Default::default()
    });

    // Start client
    client.start().await?;

    // Define a durable function
    // Note: The handler should return the result directly, not wrapped in Result
    // If errors occur, they should be handled within the function or panic
    let send_email = client.durable(
        "notifications:email:send",
        |args: (String, String)| async move {
            let (to, subject) = args;
            println!("📧 Sending email to {} with subject: {}", to, subject);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            EmailResult {
                sent: true,
                timestamp: chrono::Utc::now().to_rfc3339(),
            }
        },
        DurableOptions::default(),
    );

    // Call it
    let handle = send_email
        .call(("user@example.com".to_string(), "Welcome!".to_string()))
        .await?;

    println!("✅ Job enqueued: {}", handle.job_id());

    // Wait for result
    let result: EmailResult = handle.result().await?;
    println!(
        "📬 Result: sent={}, timestamp={}",
        result.sent, result.timestamp
    );

    // Stop client
    client.stop().await?;

    Ok(())
}
