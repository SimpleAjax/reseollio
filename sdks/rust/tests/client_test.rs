use reseolio::{
    proto::{
        self,
        reseolio_server::{Reseolio, ReseolioServer},
        AckRequest, AckResponse, CancelRequest, CancelResponse, DeleteScheduleRequest,
        DeleteScheduleResponse, EnqueueRequest, EnqueueResponse, GetJobRequest, GetScheduleRequest,
        Job, JobCompletion, PollRequest, Schedule, SubscribeRequest, UpdateScheduleRequest,
    },
    DurableOptions, ReseolioConfig,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{
    transport::{Channel, Server},
    Request, Response, Status, Streaming,
};

pub struct MockReseolioServer {
    pub job_tx: mpsc::Sender<Result<Job, Status>>,
}

#[tonic::async_trait]
impl Reseolio for MockReseolioServer {
    type PollJobsStream = ReceiverStream<Result<Job, Status>>;
    type SubscribeToJobsStream = ReceiverStream<Result<JobCompletion, Status>>;

    // ... impl methods (same as before) ...
    async fn enqueue_job(
        &self,
        request: Request<EnqueueRequest>,
    ) -> Result<Response<EnqueueResponse>, Status> {
        let req = request.into_inner();
        Ok(Response::new(EnqueueResponse {
            job_id: format!("job-{}", req.name),
            deduplicated: false,
        }))
    }

    async fn get_job(&self, _request: Request<GetJobRequest>) -> Result<Response<Job>, Status> {
        Ok(Response::new(Job {
            id: "test-job-id".to_string(),
            name: "test-job".to_string(),
            status: 1, // PENDING
            ..Default::default()
        }))
    }

    async fn cancel_job(
        &self,
        _request: Request<CancelRequest>,
    ) -> Result<Response<CancelResponse>, Status> {
        Ok(Response::new(CancelResponse {
            success: true,
            message: "".to_string(),
        }))
    }

    async fn ack_job(
        &self,
        _request: Request<AckRequest>,
    ) -> Result<Response<AckResponse>, Status> {
        Ok(Response::new(AckResponse {
            new_status: 1, // PENDING
            next_attempt: 0,
            next_run_at: 0,
        }))
    }

    async fn poll_jobs(
        &self,
        _request: Request<Streaming<PollRequest>>,
    ) -> Result<Response<Self::PollJobsStream>, Status> {
        let (_tx, rx) = mpsc::channel(1);
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn subscribe_to_jobs(
        &self,
        _request: Request<Streaming<SubscribeRequest>>,
    ) -> Result<Response<Self::SubscribeToJobsStream>, Status> {
        let (_tx, rx) = mpsc::channel(1);
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn create_schedule(
        &self,
        _request: Request<proto::CreateScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        Ok(Response::new(Schedule {
            id: "sched-123".to_string(),
            ..Default::default()
        }))
    }

    async fn get_schedule(
        &self,
        _request: Request<GetScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        Ok(Response::new(Schedule::default()))
    }

    async fn update_schedule(
        &self,
        _request: Request<UpdateScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        Ok(Response::new(Schedule::default()))
    }

    async fn delete_schedule(
        &self,
        _request: Request<DeleteScheduleRequest>,
    ) -> Result<Response<DeleteScheduleResponse>, Status> {
        Ok(Response::new(DeleteScheduleResponse {
            success: true,
            message: "".to_string(),
        }))
    }

    async fn pause_schedule(
        &self,
        _request: Request<proto::PauseScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        Ok(Response::new(Schedule::default()))
    }

    async fn resume_schedule(
        &self,
        _request: Request<proto::ResumeScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        Ok(Response::new(Schedule::default()))
    }

    async fn list_jobs(
        &self,
        _request: Request<proto::ListJobsRequest>,
    ) -> Result<Response<proto::ListJobsResponse>, Status> {
        Ok(Response::new(proto::ListJobsResponse {
            jobs: vec![],
            total: 0,
        }))
    }

    async fn list_schedules(
        &self,
        _request: Request<proto::ListSchedulesRequest>,
    ) -> Result<Response<proto::ListSchedulesResponse>, Status> {
        Ok(Response::new(proto::ListSchedulesResponse {
            schedules: vec![],
            total: 0,
        }))
    }

    async fn retry_job(
        &self,
        _request: Request<proto::RetryRequest>,
    ) -> Result<Response<proto::RetryResponse>, Status> {
        Ok(Response::new(proto::RetryResponse {
            success: true,
            message: "".to_string(),
        }))
    }
}

#[tokio::test]
async fn test_client_connection_and_enqueue() {
    let (job_tx, _job_rx) = mpsc::channel(1);
    let mock_server = MockReseolioServer { job_tx };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    println!("Mock server starting on {}", addr);

    let stream = TcpListenerStream::new(listener);

    // Start server
    let server_handle = tokio::spawn(async move {
        Server::builder()
            .add_service(ReseolioServer::new(mock_server))
            .serve_with_incoming(stream)
            .await
            .unwrap();
    });

    // Wait for server to be ready
    let mut connected = false;
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            connected = true;
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    if !connected {
        panic!("Mock server failed to bind/start on {}", addr);
    }

    // Connect Manually to debug
    let channel_result = Channel::from_shared(format!("http://{}", addr))
        .unwrap()
        .connect()
        .await;

    if let Err(e) = channel_result {
        panic!("Manual channel connection failed: {:?}", e);
    }
    let channel = channel_result.unwrap();

    // Start client
    let mut client = reseolio::Reseolio::new(ReseolioConfig {
        address: Some(format!("http://{}", addr)), // Just for config correctness
        worker_concurrency: Some(1),
        auto_start: Some(false),
        ..Default::default()
    });

    // Inject Channel
    if let Err(e) = client.start_with_channel(channel).await {
        panic!("Client failed to start: {:?}", e);
    }

    // Register dummy function
    let dur_func = client.durable(
        "test_func",
        |_: String| async { Ok::<_, String>("done".to_string()) },
        DurableOptions::default(),
    );

    // Call function
    let handle = dur_func.call("arg".to_string()).await;
    assert!(handle.is_ok());

    let handle = handle.unwrap();
    assert_eq!(handle.job_id(), "job-test_func");

    client.stop().await.unwrap();
    server_handle.abort();
}
