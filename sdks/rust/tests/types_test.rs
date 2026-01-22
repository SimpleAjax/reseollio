use reseolio::{
    proto::{self, EnqueueRequest, JobOptions},
    ReseolioConfig,
};
use serde_json::json;

#[test]
fn test_config_defaults() {
    let config = ReseolioConfig::default();
    assert_eq!(config.storage, None);
    assert_eq!(config.address, None);
}

#[test]
fn test_job_options_serialization() {
    let options = JobOptions {
        max_attempts: 5,
        backoff: "exponential".to_string(),
        initial_delay_ms: 500,
        ..Default::default()
    };

    // Test proto conversion if implemented
    // The SDK uses internal types that convert to proto
}

#[test]
fn test_enqueue_request_creation() {
    let args = json!({ "foo": "bar" });
    let args_bytes = serde_json::to_vec(&args).unwrap();

    let req = EnqueueRequest {
        name: "test".to_string(),
        args: args_bytes.clone(),
        options: None,
        idempotency_key: "key".to_string(),
    };

    assert_eq!(req.name, "test");
    assert_eq!(req.args, args_bytes);
}
