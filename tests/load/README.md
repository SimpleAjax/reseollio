# 🧪 Quick Load Testing Guide

## Setup

### 1. Build Everything
```powershell
# Build Rust core
cargo build --release

# Build Node SDK
cd sdks/node
npm run build
cd ../..
```

### 2. Start Rust Core
```powershell
# Terminal 1
$env:RUST_LOG="info"  # or "debug" for more details
.\target\release\reseolio.exe
```

---

## Running Tests

### Test 1: Basic Throughput (1 worker, 1000 jobs)

```powershell
# Terminal 2
npx tsx tests/load/01-throughput.ts
```

**What to watch:**
- Jobs/sec (target: >50)
- p99 latency (target: <500ms)
- 100% completion rate

**Expected output:**
```
📊 RESULTS
═══════════════════════════════════════
Total Jobs:       1000
Completed:        1000
Success Rate:     100.00%
Throughput:       85.23 jobs/sec
✅ TEST PASSED
```

---

### Test 2: Multi-Worker Concurrency (5 workers, 1000 jobs)

```powershell
npx tsx tests/load/02-multi-worker.ts
```

**What to watch:**
- All jobs complete
- No duplicates
- Workers share load evenly (±20%)

**Expected output:**
```
Worker Distribution:
  Worker 1:       198 jobs (19.8%)
  Worker 2:       205 jobs (20.5%)
  Worker 3:       201 jobs (20.1%)
  Worker 4:       195 jobs (19.5%)
  Worker 5:       201 jobs (20.1%)
Duplicates:       NO ✅
✅ TEST PASSED
```

---

## Creating Custom Tests

### Template
```typescript
import { Reseolio } from '../sdks/node/dist/index.js';

async function main() {
    const reseolio = new Reseolio({
        storage: 'sqlite://./test.db',
        autoStart: false,
    });

    // Track metrics
    let completed = 0;
    reseolio.on('job:success', () => completed++);

    await reseolio.start();

    // Define job
    const job = reseolio.durable('my-job', async (data) => {
        // Your logic here
        return { result: data };
    });

    // Run test
    const handles = await Promise.all([
        job({ id: 1 }),
        job({ id: 2 }),
        // ...
    ]);

    const results = await Promise.all(handles.map(h => h.result()));

    // Report
    console.log(`Completed: ${completed}`);

    await reseolio.stop();
}

main();
```

---

## Metrics to Monitor

### In Rust Core Logs
```json
{"level":"INFO","message":"Enqueued job: abc123 (job-name)"}
{"level":"INFO","message":"Acked job abc123 -> Success"}
{"level":"DEBUG","message":"Found 5 pending jobs ready to run"}
{"level":"ERROR","message":"..."}  // Should be 0!
```

### In Node SDK
```
[JOB▶️] abc123 - job-name
[JOB✅] abc123
```

### System Metrics (PowerShell)
```powershell
# CPU & Memory
Get-Process reseolio | Select-Object CPU, WS

# File size
Get-Item .\load-test.db | Select-Object Length
```

---

## Interpreting Results

### Good Signs ✅
- Throughput increases linearly with workers (up to ~10)
- Memory stable over time
- No stuck jobs
- p99 latency < 1 second
- 100% completion rate

### Red Flags ❌
- Throughput doesn't scale with workers
- Memory growing over time
- Jobs stuck in RUNNING
- Increasing latency over time
- Database locked errors

---

## Common Issues

### "Database is locked"
- WAL mode not enabled
- Too many concurrent workers
- **Fix:** Check SQLite pragma in storage init

### Jobs stuck in RUNNING
- Worker disconnected before ack
- **Check:** Enable stale job recovery
- **Verify:** Logs show recovery happening

### Low throughput
- Jobs too slow
- DB bottleneck
- **Profile:** Add `debug` logging
- **Check:** CPU usage

### Workers not sharing load
- One worker may be slow
- **Check:** Worker logs
- **Verify:** All workers polling

---

## Advanced: Profiling

### CPU Profiling (Rust)
```powershell
cargo install cargo-flamegraph
cargo flamegraph --bin reseolio
```

### Memory Profiling
```powershell
# Windows Task Manager or:
Get-Process reseolio | Select-Object WS, PM, VM
```

### Database Analysis
```powershell
sqlite3 load-test.db "SELECT status, COUNT(*) FROM jobs GROUP BY status;"
sqlite3 load-test.db "SELECT COUNT(*) FROM jobs WHERE status='RUNNING' AND started_at < datetime('now', '-5 minutes');"
```

---

## Scaling Up

### 10K Jobs
```typescript
const NUM_JOBS = 10000;
```
**Expected:** Same throughput, longer total time

### 100K Jobs
```typescript
const NUM_JOBS = 100000;
```
**Watch:** DB file size, memory usage

### 10 Workers
```typescript
const NUM_WORKERS = 10;
```
**Expected:** ~10x faster than single worker

### 100 Workers
```typescript
const NUM_WORKERS = 100;
```
**Watch:** Database contention, connection limits

---

## Next Steps

After these tests pass:

1. **Soak Test:** Run for 1+ hours
2. **Chaos Test:** Kill workers randomly
3. **Crash Recovery:** Kill core mid-execution
4. **Network Test:** Add artificial latency
5. **Failure Test:** Jobs that fail 50% of the time

**Good luck! 🚀**
