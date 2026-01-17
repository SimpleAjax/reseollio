# E2E Test Suite for Reseolio

This directory contains end-to-end tests that verify Reseolio functionality from a developer's perspective. These tests simulate real-world usage patterns that developers will encounter when integrating Reseolio into their applications.

## Prerequisites

Before running tests, ensure:

1. **Rust core is built:** `cargo build --release` (from project root)
2. **Node SDK is built:** `npm run build` (from `sdks/node`)
3. **Dependencies installed:** `npm install` (from `sdks/node`)

## Running Tests

### Run all E2E tests:
```bash
npx tsx tests/e2e/run-all.ts
```

### Run individual tests:
```bash
# Basic job lifecycle
npx tsx tests/e2e/01-basic-job-lifecycle.ts

# Retry and failure handling
npx tsx tests/e2e/02-retry-and-failure-handling.ts

# Idempotency and deduplication
npx tsx tests/e2e/03-idempotency-deduplication.ts

# Function namespacing
npx tsx tests/e2e/04-function-namespacing.ts

# Events and observability
npx tsx tests/e2e/05-events-and-observability.ts

# Workflow patterns
npx tsx tests/e2e/06-workflow-patterns.ts

# Timeout handling
npx tsx tests/e2e/07-timeout-handling.ts
```

## Test Descriptions

### 01 - Basic Job Lifecycle
Tests fundamental operations every developer needs:
- Creating and enqueuing jobs
- Waiting for job results
- Checking job status
- Getting job details
- Job cancellation
- Multiple argument types

### 02 - Retry and Failure Handling
Tests resilience mechanisms:
- Automatic retries on transient failures
- Jobs entering DEAD state after max retries
- Different backoff strategies (fixed, exponential, linear)
- Error information preservation

### 03 - Idempotency and Deduplication
Tests deduplication for exactly-once semantics:
- Same idempotency key returns same job
- Different keys create different jobs
- Keys are scoped per function name
- Jobs without keys always create new jobs
- Deduplicated jobs share results

### 04 - Function Namespacing
Tests best practices for function naming:
- Namespace helper creates correct names
- Collision detection prevents duplicates
- Multiple functions coexist
- Domain-driven design patterns

### 05 - Events and Observability
Tests event emissions for monitoring:
- `job:start` event fires correctly
- `job:success` event fires correctly
- `job:error` event fires correctly
- Events contain correct job data

### 06 - Workflow Patterns
Tests common real-world patterns:
- **Chained Jobs**: Sequential pipeline execution
- **Fan-Out/Fan-In**: Parallel processing with aggregation
- **Saga Pattern**: Compensation on failure

### 07 - Timeout Handling
Tests timeout and deadline behavior:
- Jobs complete before timeout
- Result wait timeout handling
- Custom timeout configuration
- Concurrent jobs with different durations

### 12 - Cron Schedule Lifecycle
Tests core schedule management operations:
- Creating schedules with cron expressions
- Getting schedule details by ID
- Pausing and resuming schedules
- Updating cron expressions and timezones
- Deleting schedules (soft delete)
- Listing schedules with filters
- ScheduleHandle methods (status, nextRunAt, lastRunAt)
- Convenience methods (everyMinute, hourly, daily, weekly)

### 13 - Schedule Triggering
Tests that schedules actually create jobs:
- Schedule with short interval triggers correctly
- Verifies jobs are created by the cron scheduler
- Paused schedules don't trigger
- Resume enables triggering again
- Multiple concurrent schedules
- Schedule with custom handler options

### 14 - Schedule Edge Cases
Tests error handling and boundary conditions:
- Invalid cron expression rejection
- Malformed cron (wrong field count)
- Invalid timezone handling
- Various valid cron expressions
- Various valid timezones (IANA)
- Operations on deleted schedules
- Special characters in schedule names
- Get non-existent schedule
- Double pause/resume operations
- Boundary cron values

## Writing New Tests

Follow this pattern for new E2E tests:

```typescript
import { Reseolio } from '../../src/client';

const results: { name: string; passed: boolean; error?: string }[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    console.log(passed ? `  ✅ ${name}` : `  ❌ ${name}: ${error}`);
}

async function runTests() {
    console.log('🧪 E2E Test: Your Test Name\n');

    const reseolio = new Reseolio({
        storage: 'sqlite://./e2e-test-xx.db',
        autoStart: true,
    });

    try {
        await reseolio.start();
        
        // Your tests here
        logTest('Test description', condition);
        
        // Summary
        const passed = results.filter(r => r.passed).length;
        console.log(`\n📊 Passed: ${passed}/${results.length}`);

        await reseolio.stop();
        process.exit(results.every(r => r.passed) ? 0 : 1);
    } catch (error) {
        console.error('❌ Fatal error:', error);
        await reseolio.stop().catch(() => {});
        process.exit(1);
    }
}

runTests();
```

## Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed or fatal error occurred
