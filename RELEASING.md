# Reseolio Release Guide 🚀

This document outlines the end-to-end process for building, packaging, and publishing `reseolio` to NPM with cross-platform support (Windows, Linux, macOS).

---

## 1. Prerequisites

Before you can publish, ensure you have:

1.  **NPM Account**: [Sign up](https://www.npmjs.com/signup) if you haven't.
2.  **GitHub Token**: For uploading binaries to GitHub Releases (required for the download script strategy).
3.  **Rust Toolchain**: To build the core binary.
4.  **Cross-Compilation Tools** (Optional but recommended): `zig`, `cross-rs`, or just use GitHub Actions (easiest).

---

## 2. Strategy: The "Download on Install" Pattern

Bundle 3 binaries (Win/Mac/Linux) into one NPM package makes it huge (~30MB).
Instead, we follow the industry standard (like `esbuild`, `biome`):

1.  **Build** binaries for all platforms using GitHub Actions.
2.  **Upload** them to GitHub Releases.
3.  **NPM `postinstall` script** downloads the correct binary for the user's OS on their machine.

*Note: For this guide, we will stick to a simpler **Hybrid Bundle** approach for v0.1.0 to get you started quickly without writing complex download scripts yet. We will bundle the binaries directly for simplicity.*

---

## 3. Step-by-Step Release Process

### Phase 1: Build Core Binaries (Rust)

You need to compile the Rust core for all 3 major platforms.

> **Important**: PostgreSQL support is an optional feature. By default, only SQLite is enabled.
> To build with PostgreSQL support, add `--features postgres` to the build command.

**Option A: Build Locally (If you have access to Mac/Linux machines)**
Run this on each machine:
```bash
cd core
# SQLite only (default):
cargo build --release

# With PostgreSQL support:
cargo build --release --features postgres

# Rename the output to reseolio-{os}-{arch}
# e.g., reseolio-linux-x64, reseolio-darwin-arm64, reseolio-win32-x64.exe
```


**Option B: Use GitHub Actions (Recommended)**
Create `.github/workflows/release.yml` (template provided below) to auto-build on every tag.

---

### Phase 2: Prepare the NPM Package

1.  **Organize Binaries**:
    Create a `vendor` folder in your Node SDK and place the built binaries there.
    ```text
    sdks/node/
    └── vendor/
        ├── reseolio-win32-x64.exe
        ├── reseolio-linux-x64
        └── reseolio-darwin-arm64
    ```

2.  **Update `package.json`**:
    Ensure `files` includes the vendor folder.
    ```json
    "files": [
      "dist",
      "vendor"   // <--- Crucial!
    ]
    ```

3.  **Update `client.ts` to find the correct binary**:
    Modify the `findCoreBinary()` function to detect OS and pick the right file.

    ```typescript
    private findCoreBinary(): string {
        const platform = process.platform; // 'win32', 'linux', 'darwin'
        const arch = process.arch;         // 'x64', 'arm64'
        
        const binaryName = `reseolio-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
        const bundledPath = join(__dirname, '..', 'vendor', binaryName);
        
        return bundledPath;
    }
    ```

---

### Phase 3: Publishing to NPM

1.  **Login to NPM**:
    ```bash
    npm login
    ```
    (Follow the auth prompts in browser)

2.  **Version Bump**:
    ```bash
    cd sdks/node
    npm version patch  # 0.1.0 -> 0.1.1
    # or
    npm version minor  # 0.1.0 -> 0.2.0
    ```

3.  **Build the SDK**:
    ```bash
    npm run build
    ```

4.  **Publish**:
    ```bash
    npm publish --access public
    ```

---

## 4. Automated Workflow (The "Pro" Way)

Manually copying binaries is error-prone. Here is the implementation plan for automating this via GitHub Actions.

### `.github/workflows/publish.yml`

Create this file to automate the entire flow when you push a tag (e.g., `v0.1.0`).

```yaml
name: Publish to NPM

on:
  push:
    tags:
      - 'v*'

jobs:
  build-core:
    name: Build Core (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            artifact_name: reseolio-linux-x64
            target: x86_64-unknown-linux-gnu
          - os: macos-latest
            artifact_name: reseolio-darwin-x64
            target: x86_64-apple-darwin
          - os: windows-latest
            artifact_name: reseolio-win32-x64.exe
            target: x86_64-pc-windows-msvc

    steps:
      - uses: actions/checkout@v3
      - uses: dtolnay/rust-toolchain@stable
      
      - name: Build Binary
        run: |
          cd core
          cargo build --release --features postgres --target ${{ matrix.target }}
          
      - name: Rename & Upload
        run: |
          mv core/target/${{ matrix.target }}/release/reseolio${{ matrix.os == 'windows-latest' && '.exe' || '' }} ${{ matrix.artifact_name }}
          
      - uses: actions/upload-artifact@v3
        with:
          name: binaries
          path: ${{ matrix.artifact_name }}

  publish-npm:
    needs: build-core
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
          
      - name: Download Binaries
        uses: actions/download-artifact@v3
        with:
          name: binaries
          path: sdks/node/vendor/

      - name: Publish
        run: |
          cd sdks/node
          chmod +x vendor/reseolio-* # Make executable
          npm ci
          npm run build
          npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 5. Development Workflow (When you make changes)

When you modify code in `core/` (Rust) or `sdks/node/` (TS):

1.  **Test Locally**:
    *   `cargo build --release` (Core)
    *   `npm run build` (SDK)
    *   Run your e2e tests to verify: `npx tsx tests/e2e/....`

2.  **Commit Changes**:
    *   `git commit -am "feat: added new retry logic"`
    *   `git push`

3.  **Release**:
    *   `git tag v0.2.0`
    *   `git push origin v0.2.0`
    *   Wait for GitHub Action to finish -> **It will handle build & publish!**

---

## 6. Summary of Commands

| Action | Command |
|--------|---------|
| **Build Core (SQLite only)** | `cd core && cargo build --release` |
| **Build Core (+ PostgreSQL)** | `cd core && cargo build --release --features postgres` |
| **Build SDK (Local)** | `cd sdks/node && npm run build` |
| **Pack (Test NPM)** | `npm pack` (generates .tgz to inspect) |
| **Login NPM** | `npm login` |
| **Publish** | `npm publish --access public` |

