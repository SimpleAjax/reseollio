# Reseolio Rust SDK

[![Crates.io](https://img.shields.io/crates/v/reseolio.svg)](https://crates.io/crates/reseolio)
[![Documentation](https://docs.rs/reseolio/badge.svg)](https://docs.rs/reseolio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Durable Execution for Modern Backends**

*Make any function survive server crashes, restarts, and deployments.*

[Quick Start](#-quick-start) • [Features](#-features) • [Examples](#-examples) • [API Reference](#-api-reference)

---

## ⚡ 30-Second Quick Start

Add to your `Cargo.toml`:

```toml
[dependencies]
reseolio = "0.1"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Basic usage:

```rust
use reseolio::{Reseolio, ReseolioConfig, DurableOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Reseolio::new(ReseolioConfig {
        storage: Some("postgres://user:pass@localhost:5432/mydb".to_string()),
        ..Default::default()
    });

    client.start().await?;

    // Make any function durable with one wrapper
    let send_email = client.durable(
        "notifications:email:send",
        |args: (String, String)| async move {
            let (to, subject) = args;
            // Your email sending logic here
            Ok::<_, anyhow::Error>(serde_json::json!({ "sent": true }))
        },
        DurableOptions::default(),
    );

    // Call it like a normal function - it's now crash-proof!
    let handle = send_email.call(("user@example.com".to_string(), "Welcome!".to_string())).await?;
    let result: serde_json::Value = handle.result().await?;

    println!("Result: {:?}", result);

    client.stop().await?;
    Ok(())
}
```

**That's it.** Your function now survives crashes, has automatic retries, and can be tracked.

---

## 🚀 Why Reseolio?

### 😴 Sleep Through the Night
Server crashed? Deployment rolled back? `kill -9`? Reseolio doesn't care. Your jobs pick up exactly where they left off.

### ⏳ The `await` That Survives a Crash
```rust
// Looks like normal code, but it's crash-proof and distributed
let result = handle.result().await?;
```

### 📦 Zero Infrastructure to Manage
No Redis. No RabbitMQ. No message broker cluster. Just your existing **PostgreSQL**  or **SQLite** and a single binary.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Smart Retries** | Exponential, linear, or fixed backoff with jitter |
| 🆔 **Idempotency** | Built-in deduplication prevents duplicate jobs |
| 🌍 **Global State** | PostgreSQL-backed, accessible from any node |
| ⏰ **Cron Scheduling** | Schedule recurring jobs with timezone support |
| 📊 **Observability** | Query job status, history, and results via API |
| ⚡ **Low Overhead** | ~6ms enqueue latency, ~5MB sidecar memory |
| 🔌 **Polyglot** | Language-agnostic gRPC protocol |

---

## 📚 Examples

### Fire-and-Forget Email

```rust
let send_email = client.durable(
    "notifications:email:send",
    |args: (String, String)| async move {
        let (to, subject) = args;
        email_service::send(&to, &subject).await?;
        Ok::<_, anyhow::Error>(())
    },
    DurableOptions::default(),
);

// Returns immediately - email is guaranteed to be sent
send_email.call(("user@example.com".to_string(), "Welcome!".to_string())).await?;
```

### With Retry Options

```rust
use reseolio::{BackoffStrategy, DurableOptions};

let process_payment = client.durable(
    "orders:payment:charge",
    |order_id: String| async move {
        payment_gateway::charge(&order_id).await?;
        Ok::<_, anyhow::Error>(serde_json::json!({ "charged": true }))
    },
    DurableOptions {
        max_attempts: Some(5),
        backoff: Some(BackoffStrategy::Exponential),
        initial_delay_ms: Some(1000),
        timeout_ms: Some(30000),
        ..Default::default()
    },
);
```

### Workflows (Chained Durable Functions)

```rust
// Each step is independently durable
let charge_payment = client.durable("orders:payment:charge", /* ... */);
let reserve_inventory = client.durable("orders:inventory:reserve", /* ... */);
let create_shipping = client.durable("orders:shipping:create", /* ... */);

// Orchestrator chains them
let process_order = client.durable(
    "orders:fulfillment:process",
    move |order_id: String| async move {
        let payment = charge_payment.call(order_id.clone()).await?;
        payment.result().await?;

        let inventory = reserve_inventory.call(order_id.clone()).await?;
        inventory.result().await?;

        let shipping = create_shipping.call(order_id.clone()).await?;
        shipping.result().await?;

        Ok::<_, anyhow::Error>(serde_json::json!({ "status": "fulfilled" }))
    },
    DurableOptions::default(),
);
```

### Idempotency (De-duplication)

```rust
use reseolio::JobOptions;

// Even if called 10 times, only runs once per orderId
let handle = process_payment
    .call_with_options(
        amount,
        JobOptions {
            idempotency_key: Some(format!("charge-{}", order_id)),
            ..Default::default()
        },
    )
    .await?;
```

### Cron Scheduling

```rust
use reseolio::ScheduleOptions;

// Schedule a job to run daily at 8 AM New York time
let daily_report = client.durable("reports:daily-summary", /* ... */);

let schedule = daily_report
    .schedule(
        ScheduleOptions {
            cron: "0 8 * * *".to_string(),
            timezone: Some("America/New_York".to_string()),
            handler_options: None,
        },
        args,
    )
    .await?;

// Or use convenience methods
let hourly_cleanup = task.hourly(args).await?;
let weekly_backup = task.weekly(1, 2, args).await?; // Monday at 2 AM

// Manage schedules
schedule.pause().await?;   // Stop triggering
schedule.resume().await?;  // Resume triggering
schedule.update(options).await?; // Change cron expression
schedule.delete().await?;  // Remove schedule

// Get schedule info
let next_run = schedule.next_run_at().await?;
let status = schedule.status().await?;
```

---

## 📖 API Reference

### `Reseolio::new(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage` | `Option<String>` | `"sqlite://./reseolio.db"` | PostgreSQL or SQLite connection string |
| `address` | `Option<String>` | `"127.0.0.1:50051"` | gRPC server address |
| `worker_concurrency` | `Option<u32>` | `10` | Max concurrent job executions |
| `auto_start` | `Option<bool>` | `true` | Auto-start reseolio-core binary |

### `client.durable(name, handler, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max_attempts` | `Option<u32>` | `3` | Maximum retry attempts |
| `backoff` | `Option<BackoffStrategy>` | `Exponential` | Retry backoff strategy |
| `initial_delay_ms` | `Option<u32>` | `1000` | Initial retry delay |
| `max_delay_ms` | `Option<u32>` | `60000` | Maximum retry delay |
| `timeout_ms` | `Option<u32>` | `30000` | Per-attempt timeout |
| `jitter` | `Option<f32>` | `0.1` | Randomization factor (0-1) |

### `JobHandle<T>`

| Method | Description |
|--------|-------------|
| `result() -> Result<T>` | Await job completion and get result |
| `result_with_timeout(Duration) -> Result<T>` | Await with timeout |
| `status() -> Result<JobStatus>` | Get current status |
| `details() -> Result<Job>` | Get full job details |
| `cancel() -> Result<bool>` | Cancel a pending job |

### `ScheduleHandle`

| Method | Description |
|--------|-------------|
| `details() -> Result<Schedule>` | Get full schedule details |
| `status() -> Result<ScheduleStatus>` | Get current status |
| `pause() -> Result<Schedule>` | Pause the schedule |
| `resume() -> Result<Schedule>` | Resume a paused schedule |
| `update(options) -> Result<Schedule>` | Update cron/timezone/options |
| `delete() -> Result<bool>` | Delete the schedule |
| `next_run_at() -> Result<DateTime<Utc>>` | Get next run time |
| `last_run_at() -> Result<Option<DateTime<Utc>>>` | Get last run time |

---

## 💡 Best Practices

### 1. Use Namespaces

```rust
// ❌ Ambiguous
let func = client.durable("process-data", /* ... */);

// ✅ Crystal clear
let func = client.durable("billing:subscription:charge", /* ... */);

// Or use the helper
let name = client.namespace(&["billing", "subscription", "charge"])?;
```

### 2. Keep Payloads Small

```rust
// ✅ Pass IDs
process_order.call("order-123".to_string()).await?;

// ❌ Don't pass large objects
process_order.call(huge_order_object).await?; // Bad!
```

### 3. Handle Errors Properly

```rust
client.durable(
    "task:name",
    |_: ()| async move {
        // Return Result type
        do_work().await?;
        Ok::<_, anyhow::Error>(())
    },
    DurableOptions::default(),
);
```

---

## 🆚 Comparison

| Aspect | Message Queues | Temporal | **Reseolio** |
|--------|----------------|----------|--------------|
| **Philosophy** | Fire and forget | Complex workflows | Simple durability |
| **Infrastructure** | Redis/RabbitMQ | 4+ services | **Just PostgreSQL** |
| **Learning Curve** | Moderate | Steep | **Minimal** |
| **Result Tracking** | Manual | Built-in | **Built-in** |
| **Await Job Result** | ❌ | ✅ | **✅** |

---

## 🔮 Roadmap

- [x] Visual Dashboard
- [x] Cron Scheduling
- [ ] Prometheus Metrics
- [ ] WASM Support
- [x] Rust SDK

---

## 📄 License

MIT © [Reseolio Contributors](https://github.com/SimpleAjax/reseollio)

---

<div align="center">
  <sub>Built with ❤️ for developers who want reliability without complexity.</sub>
</div>
