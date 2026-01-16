<div align="center">

# Reseolio

[![npm version](https://badge.fury.io/js/reseolio.svg)](https://www.npmjs.com/package/reseolio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Durable Execution for Modern Backends**

*Make any function survive server crashes, restarts, and deployments.*

[Quick Start](#-quick-start) • [Features](#-features) • [Examples](#-examples) • [API Reference](#-api-reference)

</div>

---

## ⚡ 30-Second Quick Start

```bash
npm install reseolio
```

```typescript
import { Reseolio } from 'reseolio';

const reseolio = new Reseolio({
  storage: 'postgres://user:pass@localhost:5432/mydb'
});

await reseolio.start();

// Make any function durable with one wrapper
const sendEmail = reseolio.durable(
  'notifications:email:send',
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

### 😴 Sleep Through the Night
Server crashed? Deployment rolled back? `kill -9`? Reseolio doesn't care. Your jobs pick up exactly where they left off.

### ⏳ The `await` That Survives a Crash
```typescript
// Looks like normal code, but it's crash-proof and distributed
const result = await generatePDFReport(data);
```

### 📦 Zero Infrastructure to Manage
No Redis. No RabbitMQ. No message broker cluster. Just your existing **PostgreSQL** and a single binary.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Smart Retries** | Exponential, linear, or fixed backoff with jitter |
| 🆔 **Idempotency** | Built-in deduplication prevents duplicate jobs |
| 🌍 **Global State** | PostgreSQL-backed, accessible from any node |
| 📊 **Observability** | Query job status, history, and results via API |
| ⚡ **Low Overhead** | ~6ms enqueue latency, ~5MB sidecar memory |
| 🔌 **Polyglot** | Language-agnostic gRPC protocol |

---

## 📊 Benchmarks

| Metric | Avg (ms) | P95 (ms) |
|--------|----------|----------|
| **Enqueue** | 6.23 | 9.57 |
| **Scheduling Lag** | 8.39 | 10.10 |
| **Full Round-Trip** | 9.85 | 11.50 |

---

## 📚 Examples

### Fire-and-Forget Email

```typescript
const sendEmail = reseolio.durable(
  'notifications:email:send',
  async (to: string, subject: string) => {
    await emailService.send(to, subject);
  }
);

// Returns immediately - email is guaranteed to be sent
await sendEmail('user@example.com', 'Welcome!');
```

### With Retry Options

```typescript
const processPayment = reseolio.durable(
  'orders:payment:charge',
  async (orderId: string) => {
    await paymentGateway.charge(orderId);
    return { charged: true };
  },
  {
    maxAttempts: 5,           // Retry up to 5 times
    backoff: 'exponential',   // exponential | linear | fixed
    initialDelayMs: 1000,     // Start with 1s delay
    timeoutMs: 30000,         // 30s timeout per attempt
  }
);
```

### Workflows (Chained Durable Functions)

```typescript
// Each step is independently durable
const chargePayment = reseolio.durable('orders:payment:charge', ...);
const reserveInventory = reseolio.durable('orders:inventory:reserve', ...);
const createShipping = reseolio.durable('orders:shipping:create', ...);

// Orchestrator chains them
const processOrder = reseolio.durable(
  'orders:fulfillment:process',
  async (orderId: string) => {
    const payment = await chargePayment(orderId);
    await payment.result();
    
    const inventory = await reserveInventory(orderId);
    await inventory.result();
    
    const shipping = await createShipping(orderId);
    await shipping.result();
    
    return { status: 'fulfilled' };
  }
);
```

### Idempotency (De-duplication)

```typescript
// Even if called 10 times, only runs once per orderId
await processPayment(amount, {
  idempotencyKey: `charge-${orderId}`
});
```

---

## 📖 API Reference

### `new Reseolio(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage` | `string` | required | PostgreSQL connection string |
| `workerConcurrency` | `number` | `10` | Max concurrent job executions |
| `namespace` | `string` | `'default'` | Isolate jobs by namespace |

### `reseolio.durable(name, handler, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum retry attempts |
| `backoff` | `string` | `'exponential'` | `'exponential'` / `'linear'` / `'fixed'` |
| `initialDelayMs` | `number` | `1000` | Initial retry delay |
| `maxDelayMs` | `number` | `60000` | Maximum retry delay |
| `timeoutMs` | `number` | `30000` | Per-attempt timeout |
| `jitter` | `number` | `0.1` | Randomization factor (0-1) |

### `JobHandle`

| Method | Description |
|--------|-------------|
| `result()` | Await job completion and get result |
| `status()` | Get current status (`pending`/`running`/`success`/`dead`) |
| `details()` | Get full job details including attempt history |
| `cancel()` | Cancel a pending job |

### Events

```typescript
reseolio.on('job:start', (job) => console.log(`Started: ${job.name}`));
reseolio.on('job:success', (job, result) => console.log(`Success: ${job.name}`));
reseolio.on('job:error', (job, error) => console.log(`Error: ${error}`));
reseolio.on('job:dead', (job) => console.log(`Dead: ${job.name}`));
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Your App (Node.js)                                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ reseolio SDK                                              │  │
│  │  - durable() wrapper                                      │  │
│  │  - Worker loop (executes YOUR code)                       │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │ gRPC                                 │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │ reseolio-core (Rust binary, ~5MB)                         │  │
│  │  - Job scheduler                                          │  │
│  │  - Retry logic                                            │  │
│  │  - Crash recovery                                         │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │                                      │
└──────────────────────────│──────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │   PostgreSQL    │
                  │  (Your existing │
                  │   database)     │
                  └─────────────────┘
```

---

## 💡 Best Practices

### 1. Use Namespaces
```typescript
// ❌ Ambiguous
reseolio.durable('process-data', ...);

// ✅ Crystal clear
reseolio.durable('billing:subscription:charge', ...);
```

### 2. Keep Payloads Small
```typescript
// ✅ Pass IDs
processOrder({ orderId: '123' });

// ❌ Don't pass large objects
processOrder({ ...hugeUserObject, ...hugeOrderHistory });
```

### 3. Set Explicit Timeouts
```typescript
reseolio.durable('...', handler, {
  timeoutMs: 5000 // Fail after 5s to prevent zombie jobs
});
```

### 4. Write Idempotent Handlers
```typescript
// Use DB constraints
await db.query('INSERT ... ON CONFLICT DO NOTHING');

// Or check state first
if (await isAlreadyProcessed(orderId)) return;
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

- [ ] Visual Dashboard (`npx reseolio ui`)
- [ ] Prometheus Metrics
- [ ] Cron Scheduling
- [ ] Python SDK
- [ ] Go SDK

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](https://github.com/SimpleAjax/reseollio/blob/main/CONTRIBUTING.md) for guidelines.

---

## 📄 License

MIT © [Reseolio Contributors](https://github.com/SimpleAjax/reseollio)

---

<div align="center">
  <sub>Built with ❤️ for developers who want reliability without complexity.</sub>
</div>
