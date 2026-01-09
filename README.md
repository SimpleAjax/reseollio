# Reseolio

> **"The SQLite of Durable Execution"**

Reseolio is an open-source, polyglot sidecar that provides durable execution for simple functions. It runs alongside your application (Node, Python, Go) as a lightweight Rust binary, persisting function calls to SQLite and ensuring they run to completion—even across server restarts.

## ✨ The Magic Moment

Kill your server (`Ctrl+C`) while a function is retrying. Restart the server, and the function **automatically resumes** where it left off.

## 🚀 Quick Start

### Node.js / TypeScript

```bash
npm install reseolio
```

```typescript
import { Reseolio } from 'reseolio';

// Initialize (auto-spawns reseolio-core)
const reseolio = new Reseolio({
  storage: 'sqlite://./reseolio.db',
});

await reseolio.start();

// Define a durable function
const sendEmail = reseolio.durable('send-email', async (to: string, body: string) => {
  await emailProvider.send(to, body);
  return { sent: true };
}, {
  maxAttempts: 5,
  backoff: 'exponential',
});

// Call it - if this crashes or fails, Reseolio retries it
const job = await sendEmail('alice@example.com', 'Hello!');

// Optionally wait for the result
const result = await job.result();
console.log(result); // { sent: true }
```

## 📦 Installation

### Prerequisites

- Node.js 18+ (for Node SDK)
- Rust 1.75+ (for building from source)

### From npm (coming soon)

```bash
npm install reseolio
```

### From source

```bash
git clone https://github.com/reseolio/reseolio
cd reseolio

# Build Rust core
cargo build --release

# Install Node SDK dependencies
cd sdks/node && npm install && npm run build
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  SDK (Node/Python/Go)                                │   │
│  │  - Wraps your functions with durable()               │   │
│  │  - Executes jobs and reports results                 │   │
│  └────────────────────┬────────────────────────────────┘   │
│                       │ gRPC                                │
│  ┌────────────────────▼────────────────────────────────┐   │
│  │  reseolio-core (Rust Binary)                         │   │
│  │  - Persists jobs to SQLite                           │   │
│  │  - Manages retries with backoff                      │   │
│  │  - Recovers from crashes                             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEOLIO_DB` | `reseolio.db` | Path to SQLite database |
| `RESEOLIO_ADDR` | `127.0.0.1:50051` | gRPC server address |
| `RESEOLIO_MAX_CONCURRENT` | `100` | Max concurrent jobs |
| `RESEOLIO_POLL_INTERVAL` | `100` | Scheduler poll interval (ms) |

### Job Options

```typescript
const job = reseolio.durable('my-job', handler, {
  maxAttempts: 5,           // Retry up to 5 times
  backoff: 'exponential',   // 'fixed', 'exponential', 'linear'
  initialDelayMs: 1000,     // First retry after 1s
  maxDelayMs: 60000,        // Cap delay at 60s
  timeoutMs: 30000,         // 30s timeout per attempt
  jitter: 0.1,              // ±10% randomization
});
```

## 📊 Job Lifecycle

```
PENDING → RUNNING → SUCCESS
                 ↘ FAILED → (retry) → PENDING
                         ↘ (max retries) → DEAD
```

## 🛣️ Roadmap

- [x] Phase 1: Localhost MVP
  - [x] SQLite storage
  - [x] Node.js SDK
  - [x] Exponential backoff
  - [ ] Python SDK
  - [ ] Dashboard CLI

- [ ] Phase 2: Production Ready
  - [ ] PostgreSQL support
  - [ ] Redis support
  - [ ] Leader election
  - [ ] Cron scheduling

- [ ] Phase 3: Cloud Platform
  - [ ] Cloud dashboard
  - [ ] Slack/PagerDuty alerts
  - [ ] Team management

## 📄 License

MIT
