use thiserror::Error;

#[derive(Error, Debug, Clone)]
pub enum ReseolioError {
    #[error("Client not connected")]
    NotConnected,

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("gRPC error: {0}")]
    GrpcError(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Job not found: {0}")]
    JobNotFound(String),

    #[error("Schedule not found: {0}")]
    ScheduleNotFound(String),

    #[error("Job failed: {0}")]
    JobFailed(String),

    #[error("Job cancelled")]
    JobCancelled,

    #[error("Job timeout after {0}ms")]
    JobTimeout(u64),

    #[error("Function already registered: {0}")]
    FunctionAlreadyRegistered(String),

    #[error("Unknown function: {0}")]
    UnknownFunction(String),

    #[error("Invalid namespace: {0}")]
    InvalidNamespace(String),

    #[error("Core process error: {0}")]
    CoreProcessError(String),

    #[error("IO error: {0}")]
    IoError(String),

    #[error("Transport error: {0}")]
    TransportError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

// Manual From implementations to allow Clone on ReseolioError
impl From<tonic::Status> for ReseolioError {
    fn from(err: tonic::Status) -> Self {
        ReseolioError::GrpcError(err.to_string())
    }
}

impl From<serde_json::Error> for ReseolioError {
    fn from(err: serde_json::Error) -> Self {
        ReseolioError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for ReseolioError {
    fn from(err: std::io::Error) -> Self {
        ReseolioError::IoError(err.to_string())
    }
}

impl From<tonic::transport::Error> for ReseolioError {
    fn from(err: tonic::transport::Error) -> Self {
        ReseolioError::TransportError(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ReseolioError>;
