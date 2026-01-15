# 🚀 Quick Start: Full-Stack Debugging

## ✅ All Changes Complete!

I've set up **complete debugging** for both Node.js client AND Rust server. Here's what's ready:

---

## 📋 Summary of Changes

### 1. **Dockerfile.loadtest**
- Builds Rust with debug symbols
- Installs `gdbserver` for remote debugging
- Creates both debug (`reseolio-debug`) and release (`reseolio`) binaries

### 2. **docker-compose.loadtest.yml** (dev service)
- Exposes port `9230` for Rust debugging
- Runs with `gdbserver :9229 /usr/local/bin/reseolio-debug`
- Server waits for debugger to attach

### 3. **launch.json**
- **"Debug Node Client"** - Debug TypeScript client code
- **"Debug Rust Server (Docker)"** - Debug Rust server in container
- **"Debug Full Stack (Client + Server)"** - Debug BOTH simultaneously! 🎉

---

## 🎯 What You Need to Do Now

### Step 1: Install VS Code Extension
```
1. Press Ctrl+Shift+X
2. Search for "C/C++"
3. Install the one by Microsoft
```

### Step 2: Copy launch.json
```powershell
# Create .vscode folder
mkdir .vscode -ErrorAction SilentlyContinue

# Copy launch config
copy launch.json .vscode\launch.json
```

### Step 3: Rebuild Docker
```powershell
cd c:\Personal\Calling\Cimulink\Projects\reseollio

# Rebuild with new debugging support
docker-compose -f docker-compose.loadtest.yml down -v dev
docker-compose -f docker-compose.loadtest.yml build dev --no-cache
docker-compose -f docker-compose.loadtest.yml up -d dev

# Verify it started
docker logs reseolio-dev
```

**You should see:**
```
==> Starting Reseolio server with debugger...
==> Debug server listening on 0.0.0.0:9229
==> Connect VS Code debugger to localhost:9230
```

### Step 4: Start Debugging!

**Option A - Debug Node Client:**
1. Set breakpoint in `sdks/node/src/client.ts` line 67
2. Press `F5`
3. Select "Debug Node Client"

**Option B - Debug Rust Server:**
1. Set breakpoint in `core/src/server.rs`
2. Press `F5`
3. Select "Debug Rust Server (Docker)"

**Option C - Debug Both! (Recommended)**
1. Set breakpoints in BOTH Node and Rust files
2. Press `F5`
3. Select **"Debug Full Stack (Client + Server)"**
4. Watch execution pause in both client AND server! 🚀

---

## 🎉 Example Debugging Session

```
SET BREAKPOINTS:
✓ Node client.ts:161  (enqueue)
✓ Rust server.rs      (EnqueueJob handler)
✓ Node client.ts:341  (job received)
✓ Node client.ts:361  (executeJob)

START: F5 → "Debug Full Stack"

EXECUTION:
⏸️ Node:161  → About to send job to server
▶️ Continue
⏸️ Rust      → Server receives job! (See the gRPC message!)
▶️ Continue  
⏸️ Node:341  → Job comes back to worker
▶️ Continue
⏸️ Node:361  → Executing handler
▶️ Continue

✅ DONE!
```

---

## 🔍 Debug Controls

| Key | Action |
|-----|--------|
| `F5` | Start debugging / Continue |
| `F10` | Step over (next line) |
| `F11` | Step into (go inside function) |
| `Shift+F11` | Step out |
| `Shift+F5` | Stop debugging |
| Hover | See variable values |

---

## 📚 Documentation

- **`RUST_DEBUGGING_GUIDE.md`** - Complete guide with examples
- **`DEBUGGING_GUIDE.md`** - Node.js debugging guide
- **`launch.json`** - VS Code debug configurations

---

## ✨ What You Can Do Now

✅ Set breakpoints in **TypeScript** client code
✅ Set breakpoints in **Rust** server code  
✅ Debug client and server **simultaneously**
✅ See the **complete request/response flow**
✅ Inspect variables on **both sides**
✅ Step through gRPC calls from **client to server**
✅ Watch jobs being enqueued, scheduled, and executed
✅ Debug the entire system end-to-end!

---

**Ready?** Just rebuild Docker and press F5! 🎊
