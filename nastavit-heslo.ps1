# Uloží heslo pre web do lokálneho súboru .heslo (je v .gitignore, na GitHub sa nedostane).
# Po zmene hesla treba spustiť .\build.ps1 a zmeny publikovať.
$ErrorActionPreference = 'Stop'
function Plain($secure) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$p1 = Plain (Read-Host 'Nové heslo (aspoň 12 znakov)' -AsSecureString)
$p2 = Plain (Read-Host 'Zopakuj heslo' -AsSecureString)
if ($p1 -ne $p2) { throw 'Heslá sa nezhodujú.' }
if ($p1.Length -lt 12) { throw 'Heslo je kratšie ako 12 znakov.' }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.heslo'), $p1, (New-Object System.Text.UTF8Encoding($false)))
'Heslo uložené. Teraz spusti .\build.ps1'
