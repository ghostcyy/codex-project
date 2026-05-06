$baseDir = "c:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\templates\full-decks\gemini"

function Download-Asset($templateName, $fileName, $unsplashId) {
    $dir = Join-Path $baseDir "$templateName\img"
    if (-Not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
    $dest = Join-Path $dir $fileName
    # Use the most reliable Unsplash source URL format
    $url = "https://images.unsplash.com/photo-$unsplashId?auto=format&fit=crop&q=80&w=1000"
    Write-Host "Downloading $url to $dest..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 15 -ErrorAction Stop
    } catch {
        Write-Host "Failed to download $unsplashId"
    }
}

# 01-tech-web3
Download-Asset "01-tech-web3" "photo-1518770660439-4636190af475.jpg" "1518770660439-4636190af475"

# 02-finance-stablecoin
Download-Asset "02-finance-stablecoin" "market.jpg" "1611974714658-94073f1d431c"
Download-Asset "02-finance-stablecoin" "readiness.jpg" "1454165833767-13300a7b1f21"
Download-Asset "02-finance-stablecoin" "custodian.jpg" "1550565118-3a14e8d0386f"
Download-Asset "02-finance-stablecoin" "yield.jpg" "1640341719975-54637731739c"
Download-Asset "02-finance-stablecoin" "handshake.jpg" "1521791136064-7986c29596ba"

# 09-fashion-ar
Download-Asset "09-fashion-ar" "photo-1512496011212-62b29934c7ef.jpg" "1512496011212-62b29934c7ef"
Download-Asset "09-fashion-ar" "photo-1596462502278-27bfdc4033c8.jpg" "1596462502278-27bfdc4033c8"
Download-Asset "09-fashion-ar" "photo-1481325580404-a51739e730a8.jpg" "1481325580404-a51739e730a8"

# 16-sports-science
Download-Asset "16-sports-science" "photo-1530549387631-6ec122263232.jpg" "1530549387631-6ec122263232"
Download-Asset "16-sports-science" "photo-1579165466541-71ae096f9055.jpg" "1579165466541-71ae096f9055"

# 17-cyber-security
Download-Asset "17-cyber-security" "photo-1558494949-ef010cbdcc48.jpg" "1558494949-ef010cbdcc48"

# 20-rogue-ai
Download-Asset "20-rogue-ai" "photo-1620833389910-a32051744bc3.jpg" "1620833389910-a32051744bc3"
