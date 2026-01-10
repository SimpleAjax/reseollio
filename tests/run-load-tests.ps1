# 🧪 Load Test Runner
# Runs all load tests in sequence and generates a report

Write-Host "🔬 Reseolio Load Test Suite" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════`n" -ForegroundColor Cyan

# Check prerequisites
Write-Host "✓ Checking prerequisites..." -ForegroundColor Yellow

if (!(Test-Path ".\target\release\reseolio.exe")) {
    Write-Host "❌ Rust core not built. Run: cargo build --release" -ForegroundColor Red
    exit 1
}

if (!(Test-Path ".\sdks\node\dist")) {
    Write-Host "❌ Node SDK not built. Run: cd sdks/node && npm run build" -ForegroundColor Red
    exit 1
}

Write-Host "✅ All prerequisites met`n" -ForegroundColor Green

# Clean up old test database
if (Test-Path ".\load-test.db") {
    Remove-Item ".\load-test.db" -Force
    Write-Host "🗑️  Cleaned up old test database`n"
}

# Start Rust core in background
Write-Host "🚀 Starting Rust core..." -ForegroundColor Yellow
$env:RUST_LOG = "info"
$coreProcess = Start-Process -FilePath ".\target\release\reseolio.exe" `
    -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 2

if ($coreProcess.HasExited) {
    Write-Host "❌ Rust core failed to start" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Rust core running (PID: $($coreProcess.Id))`n" -ForegroundColor Green

# Test results
$results = @()

function Run-Test {
    param(
        [string]$Name,
        [string]$Script
    )
    
    Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "Running: $Name" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════`n" -ForegroundColor Cyan
    
    $startTime = Get-Date
    
    try {
        $output = npx tsx $Script 2>&1
        $exitCode = $LASTEXITCODE
        $duration = (Get-Date) - $startTime
        
        Write-Host $output
        
        $result = @{
            Name = $Name
            Script = $Script
            Duration = $duration.TotalSeconds
            ExitCode = $exitCode
            Passed = ($exitCode -eq 0)
        }
        
        $script:results += $result
        
        if ($exitCode -eq 0) {
            Write-Host "`n✅ PASSED ($([math]::Round($duration.TotalSeconds, 2))s)`n" -ForegroundColor Green
        } else {
            Write-Host "`n❌ FAILED ($([math]::Round($duration.TotalSeconds, 2))s)`n" -ForegroundColor Red
        }
        
    } catch {
        Write-Host "❌ Test crashed: $_`n" -ForegroundColor Red
        $script:results += @{
            Name = $Name
            Script = $Script
            Duration = 0
            ExitCode = -1
            Passed = $false
        }
    }
    
    Start-Sleep -Seconds 2
}

# Run all tests
try {
    Run-Test "Basic Throughput" "tests/load/01-throughput.ts"
    Run-Test "Multi-Worker Concurrency" "tests/load/02-multi-worker.ts"
    Run-Test "Retry Storm" "tests/load/03-retry-storm.ts"
    
} finally {
    # Clean up
    Write-Host "`n🛑 Stopping Rust core..." -ForegroundColor Yellow
    if (!$coreProcess.HasExited) {
        Stop-Process -Id $coreProcess.Id -Force
        Write-Host "✅ Rust core stopped`n" -ForegroundColor Green
    }
}

# Summary report
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "SUMMARY REPORT" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════`n" -ForegroundColor Cyan

$passed = ($results | Where-Object { $_.Passed }).Count
$total = $results.Count
$totalTime = ($results | Measure-Object -Property Duration -Sum).Sum

Write-Host "Total Tests:    $total"
Write-Host "Passed:         $passed" -ForegroundColor Green
Write-Host "Failed:         $($total - $passed)" -ForegroundColor Red
Write-Host "Total Time:     $([math]::Round($totalTime, 2))s`n"

Write-Host "Test Details:" -ForegroundColor Yellow
foreach ($result in $results) {
    $status = if ($result.Passed) { "✅ PASS" } else { "❌ FAIL" }
    $color = if ($result.Passed) { "Green" } else { "Red" }
    $duration = [math]::Round($result.Duration, 2)
    
    Write-Host "  $status" -ForegroundColor $color -NoNewline
    Write-Host " $($result.Name) ($($duration)s)"
}

Write-Host ""

# Exit with appropriate code
if ($passed -eq $total) {
    Write-Host "🎉 All tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "⚠️  Some tests failed. Check logs above." -ForegroundColor Yellow
    exit 1
}
