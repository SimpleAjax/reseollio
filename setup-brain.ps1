
$ErrorActionPreference = "Stop"

# Configuration
$CentralRepo = "https://github.com/SimpleAjax/dev-notes.git"
$ProjectName = Split-Path -Leaf (Get-Location)

Write-Host "🔗 Linking 'private' folder to dev-notes/$ProjectName ..."

# 1. Handle existing private folder
if (Test-Path "private") {
    Write-Host "⚠️  Existing 'private' folder found. Backing it up to 'private_temp_backup'..."
    Rename-Item "private" "private_temp_backup"
}

# 2. Add submodule
try {
    Write-Host "📥 Adding submodule..."
    git submodule add --force --name private $CentralRepo private
}
catch {
    Write-Host "❌ Failed to add submodule. Restoring 'private' folder..."
    if (Test-Path "private_temp_backup") {
        if (Test-Path "private") { Remove-Item "private" -Force -Recurse }
        Rename-Item "private_temp_backup" "private"
    }
    throw $_
}

# 3. Enable Sparse Checkout
Push-Location private
try {
    Write-Host "⚙️  Configuring sparse-checkout..."
    git config core.sparseCheckout true
    git sparse-checkout init --cone
    
    # Ensure on master branch
    git checkout master 2>$null
    if ($LASTEXITCODE -ne 0) {
        git checkout -b master
    }

    # 4. Set Specific Folder
    Write-Host "🎯 Targeting folder: $ProjectName/"

    # Create the folder structure for the project (if they don't exist)
    $folders = "$ProjectName/context", "$ProjectName/insights"
    foreach ($folder in $folders) {
        if (-not (Test-Path $folder)) {
             New-Item -ItemType Directory -Force $folder | Out-Null
        }
    }
    
    # Create a .keep file to ensure git tracks the folder
    if (-not (Test-Path "$ProjectName/context/.keep")) {
        New-Item -ItemType File -Force "$ProjectName/context/.keep" | Out-Null
    }

    # Set sparse checkout to only see this project folder
    git sparse-checkout set "$ProjectName"

    # 5. Restore backed up files
    if (Test-Path "../private_temp_backup") {
        Write-Host "📦 Moving existing private files to $ProjectName/..."
        
        # Merge backup into the project folder
        Copy-Item -Path "../private_temp_backup/*" -Destination "$ProjectName" -Recurse -Force
        
        Remove-Item "../private_temp_backup" -Force -Recurse
    }

    # 6. Save structure to central repo
    Write-Host "💾 Committing and pushing structure..."
    git add .
    git commit -m "Init structure for $ProjectName" 
    
    # Push
    git push origin master

}
catch {
    Write-Host "❌ Error during configuration: $_"
    throw $_
}
finally {
    Pop-Location
}

Write-Host "✅ Done! Your ./private folder now mirrors dev-notes/$ProjectName"
