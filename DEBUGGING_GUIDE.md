# 🚀 Quick Start: Debugging the Client

## Prerequisites

Before you can debug the client, you need the Reseolio core server running. You have **two options**:

### Option A: Build the Core (One-Time Setup)

```powershell
cd c:\Personal\Calling\Cimulink\Projects\reseollio\core
cargo build --release
```

This will create `core/target/release/reseolio.exe` which the Node client automatically starts.

### Option B: Use Existing Docker Setup

Since you already have Docker Compose running (I saw it in your terminal commands), you can connect to that:

```javascript
const client = new Reseolio({
    storage: 'sqlite://./debug.db',
    address: '127.0.0.1:50051',
    autoStart: false  // ← Don't start a new core, use existing one
});
```

---

## 🔍 Debugging Methods

### Method 1: VS Code Visual Debugger 

**Step 1: Set Breakpoints**
1. Open `sdks/node/src/client.ts`
2. Click in the gutter (left of line numbers) at these key lines:
   - **Line 67** - `async start()` - See initialization
   - **Line 161** - `async enqueue()` - See job queueing
   - **Line 341** - `call.on('data')` - See jobs arriving
   - **Line 361** - `async executeJob()` - See job execution

**Step 2: Open Test File**
- Open `sdks/node/test-debug.mjs`

**Step 3: Start Debugging**
- Press `F5`
- Select "Node.js" when prompted
- Execution pauses at your first breakpoint!

**Step 4: Debug Controls**
- `F10` - Step Over (next line)
- `F11` - Step Into (go inside function)
- `Shift+F11` - Step Out (exit function)
- `F5` - Continue
- Hover over variables to see values!

---

### Method 2: Chrome DevTools

```powershell
cd sdks\node
node --inspect-brk test-debug.mjs
```

Then open Chrome and go to: `chrome://inspect`

Click "inspect" and you'll have full Chrome DevTools!

---

### Method 3: Add Debug Logs

If you prefer logging over a debugger, add console.log statements to see the execution flow:

#### In `client.ts` at line 68:
```typescript
async start(): Promise<void> {
    console.log('🔵 [1] Loading proto...');
    await this.loadProto();
    console.log('🔵 [2] Proto loaded');

    console.log(`🔵 [3] Starting client: ${this.workerId}`);
    
    if (this.config.autoStart) {
        console.log('🔵 [4] Starting core...');
        await this.startCore();
        console.log('🔵 [5] Core started');
    }

    console.log('🔵 [6] Connecting...');
    await this.connect();
    console.log('🔵 [7] Connected!');

    this.startWorkerLoop();
    console.log('🔵 [8] Worker loop started');
}
```

#### In `client.ts` at line 342:
```typescript
call.on('data', (job: Job) => {
    console.log('🟣 [JOB RECEIVED]', { id: job.id, name: job.name });
    this.executeJob(job).catch((err) => {
        this.emit('worker:error', err);
    });
});
```

#### In `client.ts` at line 362:
```typescript
private async executeJob(job: Job): Promise<void> {
    console.log('🟡 [EXECUTING]', { id: job.id, name: job.name });
    this.activeJobs.add(job.id);
    // ... rest of code
```

Then rebuild and run:
```powershell
npm run build
node test-debug.mjs
```

---

## 🎯 Key Breakpoint Locations

| Line | What Happens | Variables to Watch |
|------|-------------|-------------------|
| 67 | Client starts | `this.config`, `this.workerId` |
| 256 | Loads protobuf | `this.proto` |
| 271 | Starts Rust core | `this.coreProcess` |
| 309 | Connects to gRPC | `this.connected` |
| 329 | Polls for jobs | `this.workerStream` |
| 161 | Enqueues job | `name`, `args` |
| 341 | Receives job | `job.id`, `job.name` |
| 361 | Executes job | `this.registry[job.name]` |
| 387 | Runs handler | Step in with F11! |
| 394/404 | Acknowledges | `result.success` |

---

## 🚀 Quickest Path to Start Debugging NOW:

### If you have Docker running:

1. Modify `test-debug.mjs` to use `autoStart: false`
2. Open `client.ts`  
3. Click left of **line 67** to set breakpoint
4. Press `F5`
5. Step through with `F10`!

### If you want to build the core:

```powershell
# Build the Rust core (one-time)
cd core
cargo build --release

# Then run the debug test
cd ..\sdks\node
node test-debug.mjs
```

---

## 💡 Debugging Tips

**To see what functions are registered:**
Add a watch expression: `Object.keys(this.registry)`

**To see active jobs:**
Add a watch expression: `this.activeJobs.size`

**To see if connected:**
Add a watch expression: `this.connected`

**To debug your handler function:**
Set a breakpoint inside your `durable()` handler and press `F11` when execution reaches line 387!

---

## ❓ Need Help?

- **Core not found?** → Build it with `cargo build --release` in the `core/` directory
- **Breakpoints not hitting?** → Make sure you pressed F5 and selected "Node.js"
- **Can't step into code?** → Use `F11` not `F10`
- **Values show undefined?** → Rebuild with `npm run build` first

---

**Ready? Open `client.ts`, click line 67, press F5, and start stepping through!** 🎉
