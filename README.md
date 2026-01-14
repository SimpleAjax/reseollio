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

// Define a durable function (use namespaced names!)
const sendEmail = reseolio.durable(
  reseolio.namespace('notifications', 'email', 'send'),  // → 'notifications:email:send'
  async (to: string, body: string) => {
    await emailProvider.send(to, body);
    return { sent: true };
  },
  {
    maxAttempts: 5,
    backoff: 'exponential',
  }
);

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
  maxAttempts: 5,           // Retry up to 5 times (total 6 executions including first try)
  backoff: 'exponential',   // 'fixed', 'exponential', 'linear'
  initialDelayMs: 1000,     // Delay before FIRST RETRY (first try is immediate)
  maxDelayMs: 60000,        // Cap delay BETWEEN retries at 60s (not total delay)
  timeoutMs: 30000,         // 30s timeout per attempt
  jitter: 0.1,              // ±10% randomization to prevent thundering herd
});
```

**How Retry Delays Work:**

| Attempt | Timing | Delay Calculation |
|---------|--------|-------------------|
| **1st try** | Immediate | No delay |
| **1st retry** | After failure | `initialDelayMs` |
| **2nd retry** | After 2nd failure | Depends on `backoff` strategy |
| **3rd retry** | After 3rd failure | Depends on `backoff` strategy |

**Backoff Strategies** (with `initialDelayMs: 1000`):

- **`fixed`**: Always wait 1s → `1s, 1s, 1s, 1s, ...`
- **`exponential`**: Doubles each time → `1s, 2s, 4s, 8s, 16s, ...` (recommended)
- **`linear`**: Increases linearly → `1s, 2s, 3s, 4s, 5s, ...`

**Example Timeline** (exponential backoff):
```
job.enqueue()  →  Attempt 1 (immediate)  →  ✗ Failed
                        ↓
                  Wait 1s (initialDelayMs)
                        ↓
                  Attempt 2 (1st retry)  →  ✗ Failed
                        ↓
                  Wait 2s (1s × 2^1)
                        ↓
                  Attempt 3 (2nd retry)  →  ✅ Success
```

**How `maxDelayMs` Works** (caps delay between retries):
```typescript
// With: initialDelayMs: 1000, maxDelayMs: 10000, backoff: 'exponential'

Retry 1: wait 1s    (1s × 2^0 = 1s)
Retry 2: wait 2s    (1s × 2^1 = 2s)
Retry 3: wait 4s    (1s × 2^2 = 4s)
Retry 4: wait 8s    (1s × 2^3 = 8s)
Retry 5: wait 10s   (1s × 2^4 = 16s, capped at 10s) ✂️
Retry 6: wait 10s   (1s × 2^5 = 32s, capped at 10s) ✂️
Retry 7: wait 10s   (1s × 2^6 = 64s, capped at 10s) ✂️
// All subsequent retries wait 10s (maxDelayMs)
```

## 📝 Best Practices

### Function Naming: Use Namespaces

**Always use namespaced function names** to prevent collisions across teams and modules:

```typescript
// ✅ GOOD: Namespaced names
const sendEmail = reseolio.durable(
  reseolio.namespace('notifications', 'email', 'send'),
  async (to, subject, body) => { ... }
);

// Or use the pattern directly
const processPayment = reseolio.durable(
  'payments:billing:process',
  async (amount, userId) => { ... }
);

// ❌ BAD: Generic names (will cause collisions!)
const send = reseolio.durable('send', handler);  // Collision risk!
const process = reseolio.durable('process', handler);  // Collision risk!
```

**Why namespacing matters:**
- Different teams may use the same function names (`send`, `process`, `calculate`)
- Without namespacing, the second registration **silently overwrites** the first
- Namespacing makes your code more maintainable and debuggable

**Recommended patterns:**
- `module:service:function` - General pattern
- `team:feature:action` - Team-based organization
- `domain:entity:operation` - Domain-driven design

**Examples:**
```typescript
// E-commerce system
reseolio.namespace('orders', 'fulfillment', 'ship');        // orders:fulfillment:ship
reseolio.namespace('inventory', 'stock', 'reserve');        // inventory:stock:reserve
reseolio.namespace('notifications', 'email', 'sendReceipt'); // notifications:email:sendReceipt

// Multi-tenant SaaS
reseolio.namespace('tenant', 'billing', 'processInvoice');  // tenant:billing:processInvoice
reseolio.namespace('analytics', 'reports', 'generate');     // analytics:reports:generate
```

### Collision Detection

Reseolio automatically detects and prevents duplicate function registrations:

```typescript
const fn1 = reseolio.durable('payments:process', handler1);
const fn2 = reseolio.durable('payments:process', handler2);
// ❌ Error: Function 'payments:process' is already registered
```

### Warnings for Un-namespaced Functions

If you forget to namespace a function, Reseolio will warn you:

```typescript
const send = reseolio.durable('send', handler);
// ⚠️ Warning: Function 'send' is not namespaced. This may cause name collisions.
//   Recommended: reseolio.namespace('module', 'service', 'send')
```

### Registration vs Execution: Don't Call `durable()` in Loops

**Important:** Separate function **registration** (once) from **execution** (many times).

```typescript
// ❌ WRONG: Calling durable() in a loop
for (let i = 0; i < 10; i++) {
    const process = reseolio.durable('process-data', handler);
    // Error on i=1: Function 'process-data' is already registered!
}

// ✅ CORRECT: Register once, call many times
const processData = reseolio.durable(
    reseolio.namespace('analytics', 'data', 'process'),
    handler
);

// Then call it as many times as needed
for (let i = 0; i < 10; i++) {
    await processData(data[i]);  // ✅ Perfect!
}
```

**Best Practice:** Register all durable functions once at application startup:

```typescript
// setup.ts - Run once when app starts
export const jobs = {
    sendEmail: reseolio.durable(
        reseolio.namespace('notifications', 'email', 'send'),
        async (to, subject, body) => { /* ... */ }
    ),
    
    processPayment: reseolio.durable(
        reseolio.namespace('payments', 'billing', 'process'),
        async (amount, userId) => { /* ... */ }
    )
};

// app.ts - Use throughout your application
import { jobs } from './setup';

app.post('/checkout', async (req, res) => {
    // Call registered functions as many times as needed
    await jobs.processPayment(req.body.amount, req.user.id);
    await jobs.sendEmail(req.user.email, 'Payment Received', emailBody);
});
```

**Key principle:** 
- **Registration (`durable()`)** = Define the function once (like `function myFunc() {}`)
- **Execution (calling result)** = Use it many times (like `myFunc()`)

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
