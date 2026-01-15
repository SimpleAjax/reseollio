# Reseolio Usage Patterns & Examples

This guide covers common patterns for building reliable systems with Reseolio. Choose the right pattern based on your use case.

---

## Table of Contents

1. [Pattern 1: Simple Fire-and-Forget](#pattern-1-simple-fire-and-forget)
2. [Pattern 2: Await Result](#pattern-2-await-result)
3. [Pattern 3: Chained Durable Functions (Saga)](#pattern-3-chained-durable-functions-saga)
4. [Pattern 4: Fan-Out / Parallel Execution](#pattern-4-fan-out--parallel-execution)
5. [Real-World Scenarios](#real-world-scenarios)
6. [Choosing the Right Pattern](#choosing-the-right-pattern)

---

## Pattern 1: Simple Fire-and-Forget

**Use when**: You want to offload work and don't need the result immediately.

```typescript
import { Reseolio } from 'reseolio';

const reseolio = new Reseolio({
  storage: 'postgres://user:pass@localhost:5432/mydb'
});
await reseolio.start();

// Define a simple durable function
const sendWelcomeEmail = reseolio.durable(
  reseolio.namespace('notifications', 'email', 'welcome'),
  async (userId: string) => {
    const user = await db.users.findById(userId);
    await emailService.send({
      to: user.email,
      subject: 'Welcome!',
      template: 'welcome',
    });
    return { sent: true };
  },
  { maxAttempts: 3 }
);

// In your API handler - returns immediately
app.post('/signup', async (req, res) => {
  const user = await db.users.create(req.body);
  
  // Fire and forget - don't await the result
  await sendWelcomeEmail(user.id);
  
  res.json({ userId: user.id }); // Responds instantly
});
```

**What you get**:
- ✅ API responds immediately (non-blocking)
- ✅ Email is guaranteed to be sent (even if server restarts)
- ✅ Automatic retries on failure

---

## Pattern 2: Await Result

**Use when**: You need the result of a background job before proceeding.

```typescript
const generateReport = reseolio.durable(
  reseolio.namespace('reports', 'pdf', 'generate'),
  async (reportId: string) => {
    const data = await db.reports.getData(reportId);
    const pdfBuffer = await pdfGenerator.create(data);
    const url = await s3.upload(`reports/${reportId}.pdf`, pdfBuffer);
    return { url, pages: data.length };
  },
  { timeoutMs: 60000 } // 60 second timeout
);

// Usage
app.get('/reports/:id/download', async (req, res) => {
  const handle = await generateReport(req.params.id);
  
  // Wait for completion (up to timeout)
  const result = await handle.result(30000); // 30s client timeout
  
  res.redirect(result.url);
});
```

---

## Pattern 3: Chained Durable Functions (Saga)

**Use when**: You have a multi-step workflow where each step should be individually durable and trackable.

### ⚠️ The Problem with One Big Function

```typescript
// ❌ DANGEROUS: If inventory.reserve fails, payment.charge will re-run on retry!
const processOrder = reseolio.durable('process-order', async (orderId) => {
  await payment.charge(...);    // Succeeds
  await inventory.reserve(...); // FAILS
  await shipping.create(...);   // Never runs
});
// On retry: Customer gets charged TWICE!
```

### ✅ The Solution: Chain Separate Durable Functions

```typescript
// Step 1: Define each step as its own durable function
const chargePayment = reseolio.durable(
  reseolio.namespace('orders', 'payment', 'charge'),
  async (orderId: string) => {
    const order = await db.orders.findById(orderId);
    
    // Most payment gateways support idempotency keys
    const result = await stripe.charges.create({
      amount: order.total,
      customer: order.customerId,
    }, {
      idempotencyKey: `order-${orderId}-charge`
    });
    
    await db.orders.update(orderId, { paymentId: result.id });
    return { paymentId: result.id };
  },
  { maxAttempts: 3, backoff: 'exponential' }
);

const reserveInventory = reseolio.durable(
  reseolio.namespace('orders', 'inventory', 'reserve'),
  async (orderId: string) => {
    const order = await db.orders.findById(orderId);
    
    // Idempotent: Check if already reserved
    if (order.inventoryReserved) {
      return { alreadyReserved: true };
    }
    
    await inventory.reserve(order.items);
    await db.orders.update(orderId, { inventoryReserved: true });
    return { reserved: true };
  },
  { maxAttempts: 5, backoff: 'exponential' }
);

const createShippingLabel = reseolio.durable(
  reseolio.namespace('orders', 'shipping', 'label'),
  async (orderId: string) => {
    const order = await db.orders.findById(orderId);
    
    // Idempotent: Check if label already exists
    if (order.shippingLabelUrl) {
      return { url: order.shippingLabelUrl };
    }
    
    const label = await shippingService.createLabel(order.address);
    await db.orders.update(orderId, { shippingLabelUrl: label.url });
    return { url: label.url };
  }
);

const sendConfirmationEmail = reseolio.durable(
  reseolio.namespace('orders', 'notifications', 'confirmation'),
  async (orderId: string) => {
    const order = await db.orders.findById(orderId);
    await emailService.send({
      to: order.email,
      template: 'order-confirmation',
      data: order,
    });
    return { sent: true };
  }
);

// Step 2: Create an orchestrator that chains them
const processOrder = reseolio.durable(
  reseolio.namespace('orders', 'fulfillment', 'process'),
  async (orderId: string) => {
    // Each step is individually durable with its own retry policy!
    
    // Step 1: Charge payment
    const paymentHandle = await chargePayment(orderId, {
      idempotencyKey: `process-${orderId}-payment`
    });
    const paymentResult = await paymentHandle.result();
    console.log('Payment completed:', paymentResult);
    
    // Step 2: Reserve inventory
    const inventoryHandle = await reserveInventory(orderId, {
      idempotencyKey: `process-${orderId}-inventory`
    });
    await inventoryHandle.result();
    console.log('Inventory reserved');
    
    // Step 3: Create shipping label
    const shippingHandle = await createShippingLabel(orderId, {
      idempotencyKey: `process-${orderId}-shipping`
    });
    const shippingResult = await shippingHandle.result();
    console.log('Shipping label created:', shippingResult.url);
    
    // Step 4: Send confirmation (fire-and-forget within orchestrator)
    await sendConfirmationEmail(orderId);
    
    // Update final status
    await db.orders.update(orderId, { status: 'fulfilled' });
    
    return { status: 'fulfilled', shippingLabel: shippingResult.url };
  },
  { maxAttempts: 10, timeoutMs: 300000 } // 5 min timeout for full workflow
);

// Step 3: Trigger from API
app.post('/checkout', async (req, res) => {
  const order = await db.orders.create(req.body);
  
  // Start the workflow
  const handle = await processOrder(order.id, {
    idempotencyKey: `checkout-${order.id}`
  });
  
  // Return immediately - processing happens in background
  res.json({ 
    orderId: order.id, 
    status: 'processing',
    trackingUrl: `/orders/${order.id}/status`
  });
});
```

### What Happens on Failure?

| Crash Point | Behavior |
|-------------|----------|
| Orchestrator dies after payment enqueued | Orchestrator retries. `chargePayment(orderId)` with same idempotency key returns the EXISTING job handle. No double charge. |
| Payment step fails (e.g., declined) | Payment job retries with its own backoff. Orchestrator waits. |
| Payment succeeds, inventory fails | Orchestrator retries. Payment job is already `success` - `result()` returns immediately. Inventory retries. |
| Everything succeeds, server crashes before DB update | Orchestrator retries. All child jobs already succeeded - returns cached results instantly. Final DB update runs. |

---

## Pattern 4: Fan-Out / Parallel Execution

**Use when**: You need to run multiple independent tasks in parallel.

```typescript
const processImage = reseolio.durable(
  reseolio.namespace('media', 'image', 'process'),
  async (imageId: string, size: string) => {
    const image = await storage.download(imageId);
    const resized = await sharp(image).resize(size).toBuffer();
    const url = await storage.upload(`${imageId}-${size}`, resized);
    return { size, url };
  }
);

const processAllSizes = reseolio.durable(
  reseolio.namespace('media', 'image', 'processAll'),
  async (imageId: string) => {
    const sizes = ['thumbnail', 'medium', 'large', 'original'];
    
    // Fan out: Start all jobs in parallel
    const handles = await Promise.all(
      sizes.map(size => processImage(imageId, size, {
        idempotencyKey: `${imageId}-${size}`
      }))
    );
    
    // Wait for all to complete
    const results = await Promise.all(
      handles.map(h => h.result())
    );
    
    return { variants: results };
  }
);
```

---

## Real-World Scenarios

### Scenario 1: Webhook Delivery System

```typescript
const deliverWebhook = reseolio.durable(
  reseolio.namespace('webhooks', 'delivery', 'send'),
  async (webhookId: string) => {
    const webhook = await db.webhooks.findById(webhookId);
    
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Webhook-Signature': sign(webhook.payload, webhook.secret),
      },
      body: JSON.stringify(webhook.payload),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
    
    await db.webhooks.update(webhookId, { 
      deliveredAt: new Date(),
      status: 'delivered' 
    });
    
    return { status: response.status };
  },
  {
    maxAttempts: 10,
    backoff: 'exponential',
    initialDelayMs: 1000,    // 1s
    maxDelayMs: 3600000,     // Cap at 1 hour
  }
);
```

### Scenario 2: User Onboarding Pipeline

```typescript
// Individual steps
const createWorkspace = reseolio.durable(
  reseolio.namespace('onboarding', 'workspace', 'create'),
  async (userId: string) => {
    const workspace = await db.workspaces.create({ ownerId: userId });
    return { workspaceId: workspace.id };
  }
);

const provisionStorage = reseolio.durable(
  reseolio.namespace('onboarding', 'storage', 'provision'),
  async (userId: string, workspaceId: string) => {
    await storageService.createBucket(`user-${userId}`);
    await storageService.setQuota(`user-${userId}`, '5GB');
    return { bucket: `user-${userId}` };
  }
);

const sendWelcomeSeries = reseolio.durable(
  reseolio.namespace('onboarding', 'email', 'welcome'),
  async (userId: string) => {
    const user = await db.users.findById(userId);
    
    // Send immediate welcome
    await emailService.send(user.email, 'welcome');
    
    // Schedule follow-ups (these could be separate scheduled durables)
    await emailService.scheduleEmail(user.email, 'tips-day-1', { delay: '1d' });
    await emailService.scheduleEmail(user.email, 'tips-day-3', { delay: '3d' });
    
    return { scheduled: true };
  }
);

// Orchestrator
const onboardUser = reseolio.durable(
  reseolio.namespace('onboarding', 'user', 'complete'),
  async (userId: string) => {
    // Create workspace
    const wsHandle = await createWorkspace(userId, {
      idempotencyKey: `onboard-${userId}-workspace`
    });
    const { workspaceId } = await wsHandle.result();
    
    // Provision storage
    const storageHandle = await provisionStorage(userId, workspaceId, {
      idempotencyKey: `onboard-${userId}-storage`
    });
    await storageHandle.result();
    
    // Send welcome emails (can fail independently)
    await sendWelcomeSeries(userId, {
      idempotencyKey: `onboard-${userId}-emails`
    });
    
    // Mark onboarding complete
    await db.users.update(userId, { onboardingComplete: true });
    
    return { workspaceId, status: 'complete' };
  }
);
```

### Scenario 3: Batch Processing with Progress Tracking

```typescript
const processBatchItem = reseolio.durable(
  reseolio.namespace('batch', 'item', 'process'),
  async (batchId: string, itemId: string) => {
    const item = await db.batchItems.findById(itemId);
    
    // Do expensive processing
    const result = await heavyProcessing(item.data);
    
    // Update item status
    await db.batchItems.update(itemId, { 
      status: 'completed',
      result 
    });
    
    // Update batch progress
    await db.batches.increment(batchId, 'completedCount');
    
    return { itemId, result };
  }
);

const processBatch = reseolio.durable(
  reseolio.namespace('batch', 'job', 'process'),
  async (batchId: string) => {
    const batch = await db.batches.findById(batchId);
    const items = await db.batchItems.findByBatchId(batchId);
    
    // Fan out all items
    const handles = await Promise.all(
      items.map(item => processBatchItem(batchId, item.id, {
        idempotencyKey: `batch-${batchId}-item-${item.id}`
      }))
    );
    
    // Wait for all (with individual timeouts)
    const results = await Promise.allSettled(
      handles.map(h => h.result(60000)) // 60s per item
    );
    
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    await db.batches.update(batchId, {
      status: 'completed',
      succeeded,
      failed,
    });
    
    return { succeeded, failed, total: items.length };
  }
);
```

---

## Choosing the Right Pattern

| Scenario | Pattern | Why |
|----------|---------|-----|
| Send email after signup | Fire-and-Forget | No need to wait, just ensure it happens |
| Generate PDF and return URL | Await Result | Need the URL before responding |
| E-commerce checkout | Chained Saga | Multiple critical steps, need individual tracking |
| Process uploaded images | Fan-Out | Independent parallel tasks |
| Retry-heavy webhook delivery | Simple Durable | Single operation with aggressive retry |
| Multi-step user onboarding | Chained Saga | Sequential with per-step failure handling |

---

## Key Principles

### 1. Make Each Step Idempotent

Whether using one big durable or chained durables, each operation should be safe to retry:

```typescript
// ❌ Not idempotent
await db.users.incrementBalance(userId, 100);

// ✅ Idempotent
await db.query(`
  INSERT INTO balance_credits (user_id, credit_id, amount)
  VALUES ($1, $2, $3)
  ON CONFLICT (credit_id) DO NOTHING
`, [userId, idempotencyKey, 100]);
```

### 2. Use Idempotency Keys Consistently

```typescript
// Use the same key for the same logical operation
const handle = await processOrder(orderId, {
  idempotencyKey: `checkout-${orderId}`
});

// If called again with same key, returns the SAME job
const handle2 = await processOrder(orderId, {
  idempotencyKey: `checkout-${orderId}`
});

console.log(handle.jobId === handle2.jobId); // true
```

### 3. Keep Payloads Small

```typescript
// ❌ Don't pass large objects
await processOrder({ ...hugeOrder, ...allLineItems, ...customerHistory });

// ✅ Pass IDs, fetch fresh data inside handler
await processOrder(orderId);
```

### 4. Set Appropriate Timeouts

```typescript
// Quick API call
reseolio.durable('...', handler, { timeoutMs: 5000 });

// PDF generation
reseolio.durable('...', handler, { timeoutMs: 60000 });

// Multi-step workflow
reseolio.durable('...', handler, { timeoutMs: 300000 });
```

---

## Next Steps

- [Back to README](./README.md)
- [API Reference](./docs/API.md) *(coming soon)*
- [Troubleshooting](./docs/TROUBLESHOOTING.md) *(coming soon)*
