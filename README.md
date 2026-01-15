# Reseolio

<div align="center">

[![npm version](https://badge.fury.io/js/reseolio.svg)](https://www.npmjs.com/package/reseolio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/SimpleAjax/reseollio/pulls)

**Durable Execution for Modern Backends**

*Make any function survive server crashes, restarts, and deployments.*

[Quick Start](#-quick-start) • [Documentation](#-usage) • [Examples](#-real-world-examples) • [Contributing](#-contributing)

</div>

---

Reseolio is an open-source, polyglot sidecar that brings **durable execution** to your existing application stack. Backed by **PostgreSQL**, it ensures your critical functions run to completion—even across server crashes, restarts, or node failures.

It runs alongside your application as an ultra-lightweight **Rust binary** (~5MB RAM), managing job state globally while delegating actual code execution back to your application.

## ⚡ 30-Second Quick Start

```bash
# Install
npm install reseolio

# That's it! No separate server to run.
```

```typescript
import { Reseolio } from 'reseolio';

const reseolio = new Reseolio({
  storage: 'postgres://user:pass@localhost:5432/mydb'
});

await reseolio.start();

// Make any function durable with one wrapper
const sendEmail = reseolio.durable(
  reseolio.namespace('notifications', 'email', 'send'),
  async (to: string, subject: string) => {
    await emailService.send(to, subject);
    return { sent: true };
  }
);

// Call it like a normal function - it's now crash-proof!
const handle = await sendEmail('user@example.com', 'Welcome!');
const result = await handle.result(); // { sent: true }
```

**That's it.** Your function now survives crashes, has automatic retries, and can be tracked.

---

## 🚀 Why Reseolio?

Building reliable distributed systems usually implies massive operational complexity. Reseolio eliminates the "glue code" and infrastructure bloat typically required for reliable background jobs.

### 😴 Sleep Through the Night
Server crashed? Deployment rolled back? `kill -9`? Reseolio doesn't care. Your jobs pick up exactly where they left off the moment your app comes back online.

### ⏳ The `await` That Survives a Crash
Turn complex background work into a simple async call:
```typescript
// Looks like normal code, but it's crash-proof and distributed
const result = await generatePDFReport(data);
```

### 📦 Zero Infrastructure to Manage
No Redis. No RabbitMQ. No message broker cluster. Just your existing **PostgreSQL** and a single binary.

### 🏃 True Non-Blocking Architecture
Decouple heavy operations from API responses. Offload PDF generation, webhooks, or data processing instantly.

---

## 🌟 Real-World Examples

### Simple: Fire-and-Forget Email
```typescript
const sendEmail = reseolio.durable(
  reseolio.namespace('notifications', 'email', 'send'),
  async (to: string, subject: string) => {
    await emailService.send(to, subject);
  }
);

// Returns immediately - email is guaranteed to be sent
await sendEmail('user@example.com', 'Welcome!');
```

### Advanced: Multi-Step Workflow (Saga Pattern)

For critical workflows with multiple steps, chain durable functions for per-step durability:

```typescript
// Each step is independently durable
const chargePayment = reseolio.durable('orders:payment:charge', ...);
const reserveInventory = reseolio.durable('orders:inventory:reserve', ...);
const createShipping = reseolio.durable('orders:shipping:create', ...);

// Orchestrator chains them
const processOrder = reseolio.durable(
  reseolio.namespace('orders', 'fulfillment', 'process'),
  async (orderId: string) => {
    const payment = await chargePayment(orderId);
    await payment.result();  // Wait for payment
    
    const inventory = await reserveInventory(orderId);
    await inventory.result();  // Wait for inventory
    
    const shipping = await createShipping(orderId);
    await shipping.result();  // Wait for shipping
    
    return { status: 'fulfilled' };
  }
);
```

> 📚 **[See EXAMPLES.md](./EXAMPLES.md)** for comprehensive patterns including:
> - Fire-and-forget vs await patterns
> - Chained durable functions (saga)
> - Parallel fan-out execution
> - Real-world scenarios (e-commerce, webhooks, onboarding)
> - Best practices for idempotency

---


## ✨ Features

| Feature | Description |
|---------|-------------|
| **🔄 Smart Retries** | Exponential, linear, or fixed backoff with jitter |
| **🆔 Idempotency** | Built-in deduplication prevents duplicate jobs |
| **🌍 Global State** | PostgreSQL-backed, accessible from any node |
| **📊 Observability** | Query job status, history, and results via API |
| **⚡ Low Overhead** | ~6ms enqueue latency, ~5MB sidecar memory |
| **🔌 Polyglot** | Language-agnostic gRPC protocol (Node.js SDK today, Python/Go coming) |

---

## 📊 Benchmarks

| Metric | Avg (ms) | P95 (ms) | Notes |
|--------|----------|----------|-------|
| **Enqueue** | 6.23 | 9.57 | Time to persist job intent |
| **Scheduling Lag** | 8.39 | 10.10 | Time until worker picks up |
| **Full Round-Trip** | 9.85 | 11.50 | Total: enqueue → execute → result |

> ~6ms overhead is the "cost of durability" — negligible for most API handlers.

---

## 🆚 Comparison

| Aspect | Message Queues (BullMQ, RabbitMQ) | Temporal/Cadence | **Reseolio** |
|--------|-----------------------------------|------------------|--------------|
| **Philosophy** | Fire and forget | Complex workflows | Simple durability |
| **Infrastructure** | Redis / RabbitMQ cluster | 4+ services + Cassandra | **Just Postgres** |
| **Learning Curve** | Moderate | Steep | **Minimal** |
| **Result Tracking** | Manual | Built-in | **Built-in** |
| **Await Job Result** | ❌ | ✅ | ✅ |
| **Best For** | High-throughput pub/sub | Enterprise workflows | **App-local durability** |

---

## 📚 Full Usage

### Installation

```bash
npm install reseolio
```

**Prerequisites:**
- Node.js 18+
- PostgreSQL database

### Basic Setup

```typescript
import { Reseolio } from 'reseolio';

// Initialize ONCE at app startup
const reseolio = new Reseolio({
  storage: 'postgres://user:pass@localhost:5432/mydb',
});

await reseolio.start();

// Define durable functions
const myJob = reseolio.durable(
  reseolio.namespace('domain', 'entity', 'action'),
  async (arg1, arg2) => {
    // Your logic here
    return result;
  },
  {
    maxAttempts: 5,           // Retry up to 5 times
    backoff: 'exponential',   // exponential | linear | fixed
    initialDelayMs: 1000,     // Start with 1s delay
    timeoutMs: 30000,         // 30s timeout per attempt
  }
);

// Call it
const handle = await myJob(arg1, arg2);

// Optionally await the result
const result = await handle.result();

// Or check status later
const details = await handle.details();
console.log(details.status); // 'pending' | 'running' | 'success' | 'dead'
```

### Idempotency (De-duplication)

```typescript
// Even if called 10 times, only runs once per orderId
await processPayment(amount, {
  idempotencyKey: `charge-${orderId}`
});
```

### Monitoring Events

```typescript
reseolio.on('job:start', (job) => console.log(`Started: ${job.name}`));
reseolio.on('job:success', (job) => console.log(`Success: ${job.name}`));
reseolio.on('job:error', (job, err) => console.log(`Error: ${err}`));
```

---

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
│  │    (Executes YOUR code)          │  │        │  │    (Executes YOUR code)      │  │
│  └──────────────────────────────────┘  │        │  └──────────────────────────────┘  │
└────────────────────────────────────────┘        └────────────────────────────────────┘
```

**How it works:**
1. **Sidecar (Rust)**: Polls Postgres efficiently. When a job is ready, it signals the SDK via gRPC.
2. **Runtime (Node.js)**: Receives the signal and executes your JavaScript function.
3. **Result**: The SDK sends the result back to the Sidecar, which persists it to Postgres.

---

## 💡 Best Practices

### 1. Use Namespaces 🏷️
Prevent collisions with a strict naming convention: `domain:entity:action`

```typescript
// ❌ Ambiguous
reseolio.durable('process-data', ...)

// ✅ Crystal clear
reseolio.namespace('billing', 'subscription', 'charge')
```

### 2. Keep Payloads Small 📦
```typescript
// ✅ Pass IDs
processOrder({ orderId: '123' })

// ❌ Don't pass large objects
processOrder({ ...hugeUserObject, ...hugeOrderHistory })
```

### 3. Set Explicit Timeouts ⏱️
```typescript
reseolio.durable('...', handler, {
  timeoutMs: 5000 // Fail after 5s to prevent zombie jobs
});
```

### 4. Write Idempotent Handlers
In rare edge cases (network failure after execution but before ack), a job might retry. Make your handlers safe to re-run:
```typescript
// Use DB constraints
await db.query('INSERT ... ON CONFLICT DO NOTHING');

// Or check state first
if (await isAlreadyProcessed(orderId)) return;
```

---

## 🔮 Roadmap

- [ ] **Python SDK**
- [ ] **Go SDK**
- [ ] **Cron Scheduling**: Native `0 * * * *` expressions
- [ ] **Visual Dashboard**: Web UI for job monitoring

---

## 🤝 Contributing

We welcome contributions! 

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

MIT © [Reseolio Contributors](https://github.com/SimpleAjax/reseollio)

---

<div align="center">
  <sub>Built with ❤️ for developers who want reliability without complexity.</sub>
</div>
