//! Reseolio - Durable Execution for Modern Backends
//!
//! Rust SDK for durable function execution.
//!
//! # Quick Start
//!
//! ```no_run
//! use reseolio::{Reseolio, ReseolioConfig, DurableOptions};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let mut client = Reseolio::new(ReseolioConfig {
//!         storage: Some("postgres://user:pass@localhost:5432/mydb".to_string()),
//!         ..Default::default()
//!     });
//!
//!     client.start().await?;
//!
//!     let send_email = client.durable(
//!         "notifications:email:send",
//!         |args: (String, String)| async move {
//!             let (to, subject) = args;
//!             println!("Sending email to {} with subject: {}", to, subject);
//!             Ok::<_, anyhow::Error>(serde_json::json!({ "sent": true }))
//!         },
//!         DurableOptions::default(),
//!     );
//!
//!     let handle = send_email.call(("user@example.com".to_string(), "Welcome!".to_string())).await?;
//!     let result: serde_json::Value = handle.result().await?;
//!
//!     println!("Result: {:?}", result);
//!
//!     client.stop().await?;
//!     Ok(())
//! }
//! ```

mod client;
mod durable;
mod error;
mod job;
pub mod proto;
mod schedule;
mod tracing_support;
mod types;

// Re-exports
pub use client::{Reseolio, ReseolioConfig, ReseolioEvent};
pub use durable::DurableFunction;
pub use error::{ReseolioError, Result};
pub use job::JobHandle;
pub use schedule::ScheduleHandle;
pub use tracing_support::{init_tracing, shutdown_tracing};
pub use types::*;
