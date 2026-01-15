# Reseolio

> **"Durable Execution for Modern Backends"**

Reseolio is an open-source, polyglot sidecar that brings **durable execution** to your existing application stack. Backed by **PostgreSQL**, it ensures your critical functions run to completion—even across server crashes, restarts, or node failures.

It runs alongside your application as an ultra-lightweight **Rust binary**, managing job state globally while delegating actual code execution back to your application.

## 🚀 Why Reseolio?

Building reliable distributed systems usually implies massive operational complexity. Reseolio eliminates the "glue code" and infrastructure bloat typically required for reliable background jobs.

### 📉 Drastically Reduced Operational Burden

1.  **No More "State Tetris"**: Stop adding `status`, `last_attempt`, `next_retry_at` columns to your business tables. Reseolio handles the entire lifecycle state externally.
2.  **Goodbye, Cron Jobs**: You don't need a separate Cron scheduler to poll your database for "pending" jobs. Reseolio's scheduler pushes work to your app exactly when needed.
3.  **Zero-Infrastructure Overhead**: You don't need to manage a Redis cluster, RabbitMQ, or a heavy Temporal deployment. You just need **Postgres** (which you probably already have) and your application.
4.  **Local Context Access**: Unlike standard worker queues that run in isolated processes, Reseolio jobs execute **inside your running application instance**. This means your jobs have instant access to shared connections, in-memory caches, and global singletons without complex initialization logic.

### ⚡ Rust-Powered Efficiency

*   **Ultra-Low Memory Footprint**: The core sidecar is written in **Rust**. It consumes negligible RAM (~megabytes), leaving your server's resources for your actual application logic.
*   **In-Process Execution**: We don't spawn new heavyweight processes for every job. Your Node.js/Python/Go app executes the function directly, eliminating cold starts and process overhead.

## ✨ Features

- **🌍 Global Durability**: built on **PostgreSQL**, ensuring job state is persisted safely and accessible by any node in your cluster. If one node dies, another picks up the work immediately.
- **🔄 Smart Retries**: Built-in exponential backoff, jitter, and configurable retry limits to handle transient failures gracefully.
- **🆔 Idempotency**: Built-in deduplication ensures your jobs run exactly once per key, preventing double-billing or duplicate emails.
- **🔍 Observability**: Query job status, history, and results via a simple API. (Dashboard coming soon).
- **🗣️ Polyglot Design**: Language-agnostic gRPC protocol.

## 🆚 Comparison

### vs. Message Queues (BullMQ, Celery, RabbitMQ)
*   **Queues** are great for "fire and forget". You push a message, and maybe a worker picks it up. If the worker crashes, you might lose the job or get a duplicate.
*   **Reseolio** tracks the *entire lifecycle*. It knows if a job is running, failed, or succeeded. It stores the result. You can `await` a job's completion. It's an execution engine, not just a pipe.

### vs. Temporal / Cadence
*   **Temporal** is powerful but typically requires a heavy cluster (Frontend, History, Matching, Worker services) + Cassandra/ES. It's designed for massive, complex workflows.
*   **Reseolio** is the "minimalist" alternative. It uses your **existing Postgres** and a single sidecar binary. It provides the core promise of durable execution without the operational overhead of managing a new distributed cluster. Perfect for "Application-Local" durability or teams who want to keep their stack simple.

## 📊 Benchmarks

Reseolio adds minimal overhead to your application.

| Metric | Avg (ms) | P95 (ms) | Impact |
|--------|----------|----------|--------|
| **Direct Execution** | ~0.001 | ~0.002 | Reference Baseline |
| **Enqueue** | **6.23** | 9.57 | Added latency to your API call |
| **Scheduling Lag** | **8.39** | 10.10 | Time until worker picks it up |
| **Full Round-Trip** | **9.85** | 11.50 | Total time (Enqueue + Exec + Result) |

> **Context**: Tested on PostgreSQL. Enqueue overhead is the "cost of durability"—the time it takes to persist the job intent to disk before your code proceeds. ~6ms is negligible for most API handlers.

## 🚀 Quick Start

### 1. Installation

**Prerequisites:**
- Node.js 18+
- PostgreSQL Database
- Rust 1.75+ (only if building from source)

**Install via npm:**

```bash
npm install reseolio
```

### 2. Usage

Connect multiple instances of your app to the same Postgres database for a robust, distributed worker cluster.

**Important:** Initialize Reseolio **once** at application startup. This spawns the lightweight sidecar process (~5MB RAM) which persists for the lifecycle of your app. Do not initialize it on every request.

```typescript
import { Reseolio } from 'reseolio';

// 1. Initialize (The Rust sidecar will manage state in Postgres)
// Run this ONCE (e.g., in your app.ts or index.ts)
const reseolio = new Reseolio({
  storage: 'postgres://user:pass@localhost:5432/my_app_db', // ✅ Uses Global Postgres
});

await reseolio.start();

// 2. Define a durable function
// The actual logic runs HERE, in your Node process.
const processPayment = reseolio.durable(
  reseolio.namespace('billing', 'invoices', 'charge'),
  async (userId: string, amount: number) => {
    console.log(`Charging User ${userId} $${amount}...`);
    
    // Your business logic here...
    // Direct access to your app's DB models!
    await db.users.charge(userId, amount);
    
    return { success: true };
  },
  {
    maxAttempts: 5,
    backoff: 'exponential',
  }
);

// 3. Trigger the job
// This persists the intent to Postgres immediately.
await processPayment('user_123', 99.00);
```

## 🏗️ Architecture

```
                                      GLOBAL STATE (Postgres)
                                      ┌──────────────────────┐
                                      │  Job Queue & State   │
                                      └──────────▲───────────┘
                                                 │
                                      ┌──────────┴───────────┐
                                      │                      │
┌─────────────────────────────────────▼──┐        ┌──────────▼─────────────────────────┐
│  Node 1 (Your App)                     │        │  Node 2 (Backup/Scale-out)         │
│                                        │        │                                    │
│  ┌──────────────────────────────────┐  │        │  ┌──────────────────────────────┐  │
│  │ ⚡ Reseolio Sidecar (Rust)       │  │        │  │ ⚡ Reseolio Sidecar (Rust)   │  │
│  │    (Scheduler / Poller)          │  │        │  │    (Scheduler / Poller)      │  │
│  └──────────────┬───────────────────┘  │        │  └──────────────┬───────────────┘  │
│                 │ gRPC                 │        │                 │ gRPC             │
│  ┌──────────────▼───────────────────┐  │        │  ┌──────────────▼───────────────┐  │
│  │ 📦 Node.js Runtime               │  │        │  │ 📦 Node.js Runtime           │  │
│  │    (Executes the actual code)    │  │        │  │    (Executes the actual code)│  │
│  └──────────────────────────────────┘  │        │  └──────────────────────────────┘  │
└────────────────────────────────────────┘        └────────────────────────────────────┘
```

1.  **Sidecar (Rust)**: Polls Postgres efficiently. When a job is ready, it signals the SDK via gRPC.
2.  **Runtime (Node.js)**: Receives the signal and executes the Javascript function.
3.  **Result**: The SDK sends the result back to the Sidecar, which marks it complete in Postgres.

## 💡 Best Practices

### 1. Use Namespaces 🏷️

Namespaces are critical for preventing collisions in a distributed system. Since all jobs live in a single global table, using generic names like `sendEmail` is dangerous—if two different teams (e.g., Marketing and Auth) both register `sendEmail`, one might overwrite the other, or workers might steal each other's jobs.

**Adopt a strict convention:** `domain:entity:action`

*   ❌ `reseolio.durable('process-data', ...)` -> Ambiguous. Who processes what?
*   ✅ `reseolio.namespace('billing', 'subscription', 'charge')` -> Crystal clear.
    *   **Domain**: `billing`
    *   **Entity**: `subscription`
    *   **Action**: `charge`

### 2. Idempotency is Key 🔑

**Job Deduplication**:
When you provide an `idempotencyKey`, Reseolio ensures that if the same job is pushed twice (e.g., user double-clicks "Pay"), it is **not** created again. Instead, Reseolio returns the handle to the *existng* job. This guarantees that your job logic is triggered only once per key.

**Handler Durability**:
While Reseolio prevents duplicate triggers, your worker code should ideally be idempotent too. In rare failure cases (e.g., network crash after execution but before acknowledgement), a job might successfully run but fail to report back, causing a retry.
*   **Best Practice**: Ensure your DB updates can handle being re-run (e.g., use `ON CONFLICT DO NOTHING` or check state before updating).

```typescript
// Even if called 10 times, the customer is charged only once.
await processPayment(amount, {
  idempotencyKey: `charge-${orderId}` 
});
```

### 3. Keep Payloads Small 📦
Arguments and return values are serialized (JSON) and stored in Postgres.
*   ✅ Pass IDs: `processOrder({ orderId: '123' })`
*   ❌ Pass Objects: `processOrder({ ...hugeUserObject, ...hugeOrderHistory })`

Fetching data inside the handler ensures you always have the freshest state and keeps DB bloat low.

### 4. Handle Timeouts Gracefully ⏱️
Set explicit timeouts for your functions. Reseolio has a default, but your business logic knows best.

```typescript
reseolio.durable('...', handler, {
  timeoutMs: 5000 // If it takes longer than 5s, fail and retry
});
```
This prevents "zombie jobs" from blocking your workers forever if an external API hangs.

## 🔮 Roadmap

- [ ] **SDKs**: Python and Go SDKs.
- [ ] **Cron Scheduling**: Native support for cron expressions (`0 * * * *`) for recurring jobs.
- [ ] **Visual Dashboard**: A standalone web UI to view job history, retries, and manual overrides.

## 🤝 Contributing

We welcome contributions!
1.  Fork the repo.
2.  Create a feature branch.
3.  Submit a Pull Request.

## 📄 License

MIT
