use reseolio::{DurableOptions, Reseolio, ReseolioConfig, ScheduleOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct ReportResult {
    report_id: String,
    date: String,
    status: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let client = Reseolio::new(ReseolioConfig {
        storage: Some("sqlite://./reseolio.db".to_string()),
        ..Default::default()
    });

    client.start().await?;

    // Define a scheduled task
    let daily_report = client.durable(
        "reports:daily:generate",
        |date: String| async move {
            println!("📊 Generating daily report for {}", date);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            ReportResult {
                report_id: uuid::Uuid::new_v4().to_string(),
                date,
                status: "completed".to_string(),
            }
        },
        DurableOptions::default(),
    );

    // Schedule it to run daily at 8 AM
    let schedule = daily_report
        .schedule(
            ScheduleOptions {
                cron: "0 8 * * *".to_string(),
                timezone: Some("America/New_York".to_string()),
                handler_options: None,
            },
            chrono::Utc::now().format("%Y-%m-%d").to_string(),
        )
        .await?;

    println!("✅ Schedule created: {}", schedule.id());
    println!("📅 Next run: {}", schedule.next_run_at().await?);

    // Or use convenience methods
    let hourly_cleanup = daily_report
        .hourly(chrono::Utc::now().format("%Y-%m-%d").to_string())
        .await?;
    println!("✅ Hourly schedule created: {}", hourly_cleanup.id());

    // Pause a schedule
    schedule.pause().await?;
    println!("⏸️  Schedule paused");

    // Resume it
    schedule.resume().await?;
    println!("▶️  Schedule resumed");

    // Update the schedule
    let updated = schedule
        .update(reseolio::UpdateScheduleOptions {
            cron: Some("0 9 * * *".to_string()), // Change to 9 AM
            ..Default::default()
        })
        .await?;
    println!("🔄 Schedule updated to run at: {}", updated.cron_expression);

    client.stop().await?;

    Ok(())
}
