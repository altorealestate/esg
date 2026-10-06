# Zostaví web z priečinka zdroj\ do docs\ a zašifruje HTML stránky heslom (StatiCrypt).
# Heslo sa berie z $env:STATICRYPT_PASSWORD, inak zo súboru .heslo (vytvorí ho nastavit-heslo.ps1).
# zdroj\ a .heslo sú v .gitignore - na GitHub ide len zašifrovaný obsah docs\.
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$src   = Join-Path $root 'zdroj'
$build = Join-Path $root '.build'
$out   = Join-Path $root 'docs'
$utf8  = New-Object System.Text.UTF8Encoding($false)

$node = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -Filter 'node-v*-win-x64' | Sort-Object Name | Select-Object -Last 1
if (-not $node) { throw 'Nenašiel som Node.js v %LOCALAPPDATA%\Programs (node-v*-win-x64).' }
$env:Path = $node.FullName + ';' + $env:Path

if (-not $env:STATICRYPT_PASSWORD) {
  $hesloFile = Join-Path $root '.heslo'
  if (-not (Test-Path $hesloFile)) { throw 'Chýba heslo - spusti najprv .\nastavit-heslo.ps1' }
  $env:STATICRYPT_PASSWORD = ([IO.File]::ReadAllText($hesloFile, $utf8)).Trim()
}

function Read-Text($path) { [IO.File]::ReadAllText($path, $utf8) }
function Write-Text($path, $text) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  [IO.File]::WriteAllText($path, $text, $utf8)
}
$noindex = '<meta name="robots" content="noindex, nofollow">'

foreach ($dir in $build, $out) { if (Test-Path $dir) { Remove-Item $dir -Recurse -Force } }

# 1) Úvodná stránka
Copy-Item (Join-Path $src 'index.html') (Join-Path (New-Item -ItemType Directory -Force $build) 'index.html')

# 2) ESG Portfolio Monitor - dáta (esg-db.json) sa vložia priamo do stránky, aby boli zašifrované spolu s ňou.
#    esg-db.js ich načíta z <script id="esg-seed-json"> (podpora "standalone build").
#    support.js, image-slot.js a esg-db.js sú len kód bez dát - idú vedľa stránky nezašifrované.
$html = Read-Text (Join-Path $src 'portfolio\index.html')
$seed = (Read-Text (Join-Path $src 'portfolio\esg-db.json')).Replace('</', '<\/')
$anchor = '<meta name="viewport" content="width=device-width, initial-scale=1">'
if (-not $html.Contains($anchor)) { throw 'portfolio\index.html: nenašiel som <meta name="viewport"> na vloženie dát.' }
$html = $html.Replace($anchor, $anchor + "`n" + $noindex + "`n<script type=""application/json"" id=""esg-seed-json"">" + $seed + '</script>')
Write-Text (Join-Path $build 'portfolio\index.html') $html
foreach ($f in 'support.js', 'image-slot.js', 'esg-db.js') { Copy-Item (Join-Path $src "portfolio\$f") (Join-Path $build "portfolio\$f") }

# 3) Zistenia k zberu ESG dát (artifact z claude.ai)
$html = Read-Text (Join-Path $src 'zistenia\index.html')
$html = $html -replace '(<meta name=viewport[^>]*>)', ('$1' + $noindex)
Write-Text (Join-Path $build 'zistenia\index.html') $html

# 4) Šifrovanie
Push-Location $root
try {
  & npx.cmd staticrypt $build -r -d $out --short `
    --template-title 'ESG · Alto Real Estate' `
    --template-instructions 'Stránka je chránená heslom.' `
    --template-placeholder 'Heslo' `
    --template-button 'Otvoriť' `
    --template-remember 'Zapamätať si ma' `
    --template-error 'Nesprávne heslo' `
    --template-toggle-show 'Zobraziť heslo' `
    --template-toggle-hide 'Skryť heslo' `
    --template-color-primary '#717666' `
    --template-color-secondary '#f6f6f4'
  if ($LASTEXITCODE -ne 0) { throw "staticrypt skončil s chybou $LASTEXITCODE" }
} finally { Pop-Location }
# staticrypt zachová názov vstupného priečinka (docs\.build\...) - presunúť obsah priamo do docs\
$nested = Join-Path $out (Split-Path $build -Leaf)
Get-ChildItem $nested -Force | Move-Item -Destination $out
Remove-Item $nested, $build -Recurse -Force
Write-Text (Join-Path $out '.nojekyll') ''

# 5) Kontrola: žiadna HTML stránka v docs\ nesmie obsahovať čitateľné dáta.
foreach ($f in Get-ChildItem $out -Recurse -Filter *.html) {
  $t = Read-Text $f.FullName
  if (-not $t.Contains('staticrypt') -or $t.Contains('esg-seed-json') -or $t.Contains('Digital Park')) {
    throw "KONTROLA ZLYHALA: $($f.FullName) nie je zašifrovaný - nič nepublikuj!"
  }
}
Get-ChildItem $out -Recurse -File -Force | ForEach-Object { '{0,-28} {1,8} B' -f $_.FullName.Substring($out.Length + 1), $_.Length }
'Hotovo: docs\ je zašifrovaný a pripravený na commit.'
