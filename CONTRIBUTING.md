# Contributing to Reseolio

Thank you for your interest in contributing to Reseolio! We welcome contributions from the community.

## 🚀 Quick Start

1. **Fork the repository**
   - Click the "Fork" button on the [Reseolio GitHub page](https://github.com/SimpleAjax/reseollio)
   - Clone your fork: `git clone https://github.com/YOUR_USERNAME/reseollio.git`

2. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Make your changes**
   - Write code
   - Add tests
   - Update documentation

4. **Test your changes**
   ```bash
   # Run E2E tests
   cd sdks/node
   npm run test:e2e
   
   # Run load tests
   npm run test:load
   
   # Run all tests
   npm run test:all
   ```

5. **Commit and push**
   ```bash
   git add .
   git commit -m "feat: add awesome feature"
   git push origin feature/your-feature-name
   ```

6. **Create a Pull Request**
   - Go to your fork on GitHub
   - Click "Compare & pull request"
   - Fill out the PR template
   - Wait for review

## 📋 Branch Protection

Direct pushes to `main` are **disabled**. All changes must go through Pull Requests.

### PR Requirements
- ✅ At least 1 approval from maintainers
- ✅ All CI/CD checks must pass
- ✅ All conversations must be resolved
- ✅ No merge conflicts

## 🎯 What to Contribute

### Good First Issues
- Documentation improvements
- Test coverage expansion
- Bug fixes
- Example code

### Feature Contributions
- New SDKs (Python, Go, etc.)
- Performance optimizations
- New retry strategies
- Dashboard improvements

### Not Currently Accepting
- Breaking API changes (without discussion first)
- Features that duplicate existing functionality
- Significant architectural rewrites (open an issue first)

## 💻 Development Setup

### Prerequisites
- Node.js 18+
- Rust 1.70+
- PostgreSQL (for Postgres storage backend)
- Git

### Initial Setup
```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/reseollio.git
cd reseollio

# Install dependencies
npm install

# Build the Rust core
cd core
cargo build --release --features postgres

# Build the Node.js SDK
cd ../sdks/node
npm run build
```

### Running Tests
```bash
# E2E tests
npm run test:e2e

# Load tests
npm run test:load

# All tests
npm run test:all
```

## 📝 Code Style

### TypeScript/JavaScript
- Use **ESLint** configuration in the repo
- Run `npm run lint` before committing
- Use TypeScript strict mode
- Follow async/await patterns (no callbacks)

### Rust
- Run `cargo fmt` before committing
- Run `cargo clippy` and fix warnings
- Use `#[tracing::instrument]` for important functions
- Write doc comments (`///`) for public APIs

### Commit Messages
Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new retry strategy
fix: resolve race condition in postgres storage
docs: update README with examples
test: add e2e test for chained workflows
chore: update dependencies
```

## 🧪 Testing Guidelines

### When to Write Tests
- **Always** for bug fixes (test should fail before your fix)
- **Always** for new features
- **Recommended** for refactoring

### Test Coverage
- E2E tests: `sdks/node/tests/e2e/`
- Load tests: `sdks/node/tests/load/`
- Unit tests: TBD (contributions welcome!)

### Test Naming
```typescript
// Good
it('should retry job 3 times with exponential backoff', async () => {
  // ...
});

// Bad
it('test retry', async () => {
  // ...
});
```

## 📚 Documentation

### When to Update Docs
- Adding a new feature → Update README.md and EXAMPLES.md
- Changing API → Update TypeScript types and doc comments
- Fixing a bug → Update CHANGELOG.md
- New SDK → Create SDK-specific README

### Documentation Standards
- Include code examples
- Explain **why**, not just **what**
- Use real-world scenarios
- Keep it concise

## 🐛 Reporting Bugs

1. **Search existing issues** first
2. **Create a new issue** with:
   - Clear title
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment (OS, Node version, PostgreSQL version)
   - Minimal reproducible example

## 💡 Proposing Features

1. **Open a discussion** or issue first
2. **Explain the use case** - what problem does it solve?
3. **Provide examples** - how would the API look?
4. **Consider alternatives** - why is this the best approach?

## 🔍 Code Review Process

### What Reviewers Look For
- ✅ Code quality and readability
- ✅ Test coverage
- ✅ Documentation updates
- ✅ No breaking changes (without discussion)
- ✅ Performance implications
- ✅ Security considerations

### Review Timeline
- **Simple fixes**: 1-2 days
- **New features**: 3-7 days
- **Major changes**: 1-2 weeks

We'll do our best to review promptly, but please be patient!

## 🏆 Recognition

All contributors will be:
- Listed in the README
- Mentioned in release notes
- Given credit in commit messages

## 📬 Communication

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Questions, ideas, general discussion
- **Pull Requests**: Code contributions

## ❓ Questions?

If you're unsure about anything:
1. Check existing issues and discussions
2. Open a new discussion
3. Tag maintainers if needed

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make Reseolio better! 🎉
