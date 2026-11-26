<#
quartz-ff-golive.ps1 -- a CODE-ONLY Quartz release live (main 10-18, from tools/lumen-golive.ps1).
For a release whose package-lock.json and install-relevant package.json fields are unchanged since the live HEAD, so the castlabs
Electron already in node_modules (EVS-signed at release 1) stays as it is: no npm, no swap, no re-sign.

    powershell -NoProfile -ExecutionPolicy Bypass -File <this> -Ref origin/wk/lumen-release3 -Expect <sha> [-DryRun]

  -Repo defaults to the checkout this script is in (the live one); -Lnk to the Start Menu Quartz.lnk
  under %APPDATA%. A dry run's "live checkout" probe also looks at the checkout this script is in.

  0. Preflight, with Quartz still open: git fetch; the checkout is clean and on master; HEAD -> Ref is a
     fast-forward; Ref is exactly -Expect; package-lock.json is byte-identical HEAD..Ref or a version bump
     (only its root "version" and packages[""].version changed, both to the target package.json's
     "version"; tools/golive-lockfile.js decides, on node's JSON.parse), and package.json
     is either unchanged or differs only in fields npm/Electron never read at install or start (license,
     description, scripts, ...; compared as parsed JSON, the PASS line names them) (else STOP: that
     needs the swap script); node_modules electron is +wvcus and Quartz.exe.sig exists.
     A DEPENDENCY RELEASE (a new castlabs Electron tag, any lockfile change) is refused here, before
     Quartz is closed: this script never runs npm, never swaps node_modules\electron and never
     re-signs, so going ahead would leave the live copy on the OLD Electron under new code. The STOP
     line prints the exact command that does it instead (Dependency-Release below):
       tools\lumen-golive.ps1 -Repo <repo> -Ref <ref> -DryRun, then the same without -DryRun,
     which closes Quartz, fast-forwards, runs tools\drm-swap.ps1 -NoMerge (old electron moved aside
     for tools\drm-rollback.ps1, npm install --ignore-scripts, electron's install.js, Quartz.exe,
     castlabs EVS sign-pkg -H Quartz + verify-pkg) and relaunches. EVS must be signed in first
     (py -3 -m castlabs_evs.account reauth: the user's step); lumen-golive.ps1 has no -Expect, so
     check that <ref> is still the reviewed SHA between the dry run and the real one.
  1. Snapshot the default-browser registry and node-pty's native files and Quartz.exe(.sig) hashes.
  2. Close Quartz cleanly (CloseMainWindow on the MAIN Quartz.exe of this checkout; never kills).
  3. git merge --ff-only Ref.  (DRY RUN: skipped; the live checkout is never touched.)
  4. CHECK ONLY: electron still +wvcus; Quartz.exe and Quartz.exe.sig byte-identical to step 1.
  5. node-pty: the same bytes as before.
  6. Relaunch through explorer.exe on the Start Menu Quartz.lnk (keeps the AUMID).
  7. The registry compared with step 1's snapshot: it must be untouched.
  8. The rollback command (git reset --hard <old HEAD>; no Electron change to undo).
  Every check prints a PASS / FAIL line; the last line is the verdict. Secrets are never printed.
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Ref = 'origin/wk/lumen-release3',
  [string]$Expect = '',
  [string]$Lnk = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Quartz.lnk'),
  [int]$CloseTimeoutSec = 90,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
# The live Quartz.exe a dry run probes: the one in the checkout this script lives in.
$LiveExe = (Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\electron\dist\quartz.exe').ToLower()
$Dist = Join-Path $Repo 'node_modules\electron\dist'
$PtyDir = Join-Path $Repo 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release'
$StateDir = Join-Path $env:LOCALAPPDATA 'Quartz-drm\ff-golive'
$script:fails = 0
$script:oldHead = ''
$script:merged = $false

function Say([string]$t) { Write-Output ('ff-golive: ' + $t) }
function Exe-Hash {
  $out = @()
  foreach ($n in @('Quartz.exe', 'Quartz.exe.sig')) {
    $p = Join-Path $Dist $n
    if (Test-Path $p) { $out += ($n + ':' + (Get-FileHash $p -Algorithm SHA256).Hash) } else { $out += ($n + ':missing') }
  }
  return ($out -join ';')
}
function Clean([string]$t) { if (-not $t) { return '' }; return ($t -replace '[A-Za-z0-9_\-\.=/+]{32,}', '<redacted>') }
function Tail([string]$t, [int]$n) { if (-not $t) { return '' }; $l = @($t -split "`r?`n" | Where-Object { $_.Trim() }); return (Clean (($l | Select-Object -Last $n) -join ' | ')) }
function Pass([string]$what) { Write-Output ('PASS ' + $what) }
function Fail([string]$what) { Write-Output ('FAIL ' + $what); $script:fails++ }
function Info([string]$what) { Write-Output ('INFO ' + $what) }

# One top-level package.json field as canonical JSON text: object keys sorted (ordinal), arrays kept
# in order, scalars through ConvertTo-Json, so two parses compare by value and not by layout. An
# absent field is '<absent>', which never equals a present one (even a present null).
function Json-Canon($obj, [string]$field) {
  $p = $obj.PSObject.Properties[$field]
  if ($null -eq $p) { return '<absent>' }
  return (Json-Value $p.Value)
}
function Json-Value($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [System.Management.Automation.PSCustomObject]) {
    $keys = @($v.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $parts = @()
    foreach ($k in $keys) { $parts += ((ConvertTo-Json -InputObject $k -Compress) + ':' + (Json-Value $v.PSObject.Properties[$k].Value)) }
    return ('{' + ($parts -join ',') + '}')
  }
  if ($v -is [array]) {
    $parts = @()
    foreach ($e in $v) { $parts += (Json-Value $e) }
    return ('[' + ($parts -join ',') + ']')
  }
  return (ConvertTo-Json -InputObject $v -Compress)
}

function Rollback-Text {
  $old = $(if ($script:oldHead) { $script:oldHead } else { '<HEAD before go-live>' })
  Write-Output 'ff-golive: ROLLBACK (close Quartz first, the same clean way; no Electron change to undo):'
  Write-Output ('  1. the code:   git -C ' + $Repo + ' reset --hard ' + $old)
  Write-Output ('  2. relaunch:   explorer.exe "' + $Lnk + '"')
}
# The refusal text for a release that changes what npm installs: why this script cannot take it,
# and the exact command that can. Every "needs the swap" STOP goes through here, so none of them
# ends on a bare script name (tests/golive-procs-test.js checks that).
function Dependency-Release([string]$what) {
  $swapGolive = Join-Path $Repo 'tools\lumen-golive.ps1'
  return ($what + ': a dependency release. This script never runs npm, swaps node_modules\electron or re-signs, ' +
    'so the live copy would stay on the old Electron. With EVS signed in ' +
    '(py -3 -m castlabs_evs.account reauth), run: powershell -NoProfile -ExecutionPolicy Bypass -File "' + $swapGolive +
    '" -Repo "' + $Repo + '" -Ref ' + $Ref + ' -DryRun, then the same without -DryRun (it closes Quartz, ' +
    'swaps and re-signs Electron, relaunches; rollback: tools\drm-rollback.ps1)')
}
function Stop-Golive([string]$t) {
  Fail $t
  Write-Output ('ff-golive: STOPPED - ' + $t + $(if ($script:merged) { ' (HEAD WAS ALREADY FAST-FORWARDED)' } else { ' (the checkout was NOT changed)' }))
  Rollback-Text
  Write-Output ('ff-golive: verdict FAIL (' + $script:fails + ' failed)' + $(if ($DryRun) { ' [dry run]' } else { '' }))
  exit 1
}

# A native command, its output to a file (PowerShell 5.1 turns stderr into errors otherwise).
function Run([string]$exe, [string[]]$argList) {
  $log = [IO.Path]::GetTempFileName()
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $Repo
  try { & $exe @argList *> $log; $code = $LASTEXITCODE } finally { Pop-Location; $ErrorActionPreference = $old }
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { $text = '' } else { $text = [string]$text }
  Remove-Item $log -ErrorAction SilentlyContinue
  return @{ code = $code; text = $text }
}

# Every Quartz.exe / electron.exe running from THIS checkout's electron (never by image name alone).
function Here-Procs {
  $root = ($Dist + '\').ToLower()
  return @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe' OR Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($root) })
}
function Main-Procs { return @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--test-profile' }) }
function Test-Procs { return @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--test-profile' }) }

function Reg-Snapshot {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($k in @('HKCU:\Software\Classes\QuartzURL', 'HKCU:\Software\Classes\QuartzHTML', 'HKCU:\Software\Clients\StartMenuInternet\Quartz')) {
    if (-not (Test-Path $k)) { $out.Add($k + ' <absent>'); continue }
    $items = @(Get-Item $k) + @(Get-ChildItem $k -Recurse -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
      foreach ($n in $item.GetValueNames()) { $out.Add($item.Name + '|' + $n + '=' + [string]$item.GetValue($n, $null, 'DoNotExpandEnvironmentNames')) }
    }
  }
  $ra = Get-ItemProperty 'HKCU:\Software\RegisteredApplications' -Name Quartz -ErrorAction SilentlyContinue
  $out.Add('RegisteredApplications|Quartz=' + [string]$(if ($ra) { $ra.Quartz } else { '' }))
  foreach ($p in @('Shell\Associations\UrlAssociations\http', 'Shell\Associations\UrlAssociations\https', 'CurrentVersion\Explorer\FileExts\.html', 'CurrentVersion\Explorer\FileExts\.htm')) {
    $uc = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\' + $p + '\UserChoice') -Name ProgId -ErrorAction SilentlyContinue
    $out.Add($p + ' UserChoice ProgId=' + [string]$(if ($uc) { $uc.ProgId } else { '' }))
  }
  return (($out | Sort-Object) -join "`n")
}

function Pty-Hash {
  if (-not (Test-Path $PtyDir)) { return '' }
  return ((Get-ChildItem $PtyDir -Filter *.node | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ';')
}

Say ('repo ' + $Repo + ', target ' + $Ref + $(if ($DryRun) { ' [DRY RUN: Quartz is not closed and nothing is swapped]' } else { '' }))
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---- 0. preflight (Quartz still open) ------------------------------------------------------
if (-not (Test-Path (Join-Path $Repo '.git'))) { Stop-Golive ($Repo + ' is not a Quartz checkout') }
$f = Run 'git' @('fetch', 'origin')
if ($f.code -ne 0) { Stop-Golive ('git fetch origin failed: ' + (Tail $f.text 2)) }
Pass 'preflight: git fetch origin'
$dirty = (Run 'git' @('status', '--porcelain', '--untracked-files=no')).text
if ($dirty.Trim()) { Stop-Golive ('uncommitted changes in ' + $Repo + ': ' + (Tail $dirty 3)) }
Pass 'preflight: checkout clean'
$branch = (Run 'git' @('rev-parse', '--abbrev-ref', 'HEAD')).text.Trim()
$script:oldHead = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()
$target = (Run 'git' @('rev-parse', '--verify', '--quiet', $Ref)).text.Trim()
if (-not $target) { Stop-Golive ($Ref + ' does not exist after the fetch') }
if ($branch -eq 'master') { Pass 'preflight: on master' } elseif ($DryRun) { Info ('preflight: on ' + $branch + ' (dry run on a worktree; the real run needs master)') } else { Stop-Golive ('on ' + $branch + ', not master') }
if ((Run 'git' @('merge-base', '--is-ancestor', $script:oldHead, $target)).code -ne 0) { Stop-Golive ('HEAD ' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + ' is not a fast-forward') }
Pass ('preflight: ' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + ' is a fast-forward')
$om = (Run 'git' @('rev-parse', '--verify', '--quiet', 'origin/master')).text.Trim()
if ($om -eq $target) { Pass ('preflight: origin/master is ' + $target.Substring(0, 7) + ' too') }
else { Info ('preflight: origin/master is ' + $(if ($om) { $om.Substring(0, 7) } else { 'missing' }) + ', not ' + $target.Substring(0, 7) + ' (main pushes master to the same SHA first)') }
if ($Expect) {
  if ($target.StartsWith($Expect)) { Pass ('preflight: ' + $Ref + ' is the expected ' + $target.Substring(0, 7)) } else { Stop-Golive ($Ref + ' is ' + $target.Substring(0, 7) + ', not the expected ' + $Expect) }
} else { Stop-Golive 'no -Expect SHA given; refusing to ship whatever the branch points at' }
$pkgShow = Run 'git' @('show', ($target + ':package.json'))
if ($pkgShow.code -ne 0) { Stop-Golive ('git show ' + $target.Substring(0, 7) + ':package.json failed: ' + (Tail $pkgShow.text 2)) }
$pkgAt = $pkgShow.text
if ($pkgAt -match '"electron":\s*"[^"]*#v[0-9.]+\+wvcus"') { Pass 'preflight: the target package.json pins castlabs Electron (+wvcus)' } else { Stop-Golive 'the target package.json does not pin a castlabs +wvcus Electron' }
# The lockfile must be byte-identical HEAD..target: any change to it means npm would resolve a
# different tree, and that is the swap script's job (npm + swap + re-sign), never this one's.
# The one exception is a version bump: npm writes the lockfile's root "version" and packages[""].version
# from package.json and they pin nothing, so a lockfile whose only changes are those two, both equal to
# the target package.json's "version", is still code-only. tools/golive-lockfile.js (next to this
# script) decides on node's JSON.parse; Windows PowerShell's ConvertFrom-Json cannot read a lockfile
# (it rejects the "" key). No node, no helper, or any other answer than its exit 0 refuses.
$lockNote = 'lockfile unchanged'
$lock = Run 'git' @('diff', '--quiet', $script:oldHead, $target, '--', 'package-lock.json')
if ($lock.code -ne 0 -and $lock.code -ne 1) { Stop-Golive (Dependency-Release ('package-lock.json could not be compared HEAD..target (git diff exit ' + $lock.code + ': ' + (Tail $lock.text 1) + '), so it is treated as')) }
if ($lock.code -eq 1) {
  $lockJs = Join-Path $PSScriptRoot 'golive-lockfile.js'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Golive (Dependency-Release 'package-lock.json changed HEAD..target and node is not on PATH to prove it only a version bump, so it is treated as') }
  if (-not (Test-Path $lockJs)) { Stop-Golive (Dependency-Release ('package-lock.json changed HEAD..target and ' + $lockJs + ' is missing to prove it only a version bump, so it is treated as')) }
  $lv = Run 'node' @($lockJs, $Repo, $script:oldHead, $target)
  if ($lv.code -ne 0) { Stop-Golive (Dependency-Release ('package-lock.json changed HEAD..target: ' + (Tail $lv.text 1))) }
  $lockNote = 'lockfile differs only in its version (' + (Tail $lv.text 1) + ')'
  Pass ('preflight: package-lock.json is a version bump, code-only: ' + (Tail $lv.text 1))
}
# package.json may change in fields npm and Electron never read at install or start time (license,
# description, author, scripts, ...): node_modules stays valid, so the release is still code-only.
# Every field that feeds the install, the swap or the start path must be identical, compared as
# parsed JSON (key order and whitespace do not count; values do). Anything unparseable refuses.
$pkg = Run 'git' @('diff', '--quiet', $script:oldHead, $target, '--', 'package.json')
if ($pkg.code -eq 0) { Pass $(if ($lock.code -eq 0) { 'preflight: package.json and package-lock.json are unchanged HEAD..target (code-only release)' } else { 'preflight: package.json unchanged HEAD..target; ' + $lockNote + '; code-only release' }) }
else {
  $pkgOldShow = Run 'git' @('show', ($script:oldHead + ':package.json'))
  if ($pkgOldShow.code -ne 0) { Stop-Golive ('git show ' + $script:oldHead.Substring(0, 7) + ':package.json failed: ' + (Tail $pkgOldShow.text 2)) }
  $pjOld = $null; $pjNew = $null; $why = ''
  # Strict parse first: PowerShell 5.1's ConvertFrom-Json is lenient (it takes unquoted keys, which
  # npm rejects), so node's JSON.parse, the parser npm itself uses, must accept both blobs. It reads
  # them straight from git (no console code page in between); a BOM is dropped, as npm does.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $why = 'node is not on PATH, so it cannot be strictly parsed' }
  foreach ($rev in @($script:oldHead, $target)) {
    if ($why) { break }
    $sp = Run 'node' @('-e', "try { JSON.parse(require('child_process').execFileSync('git', ['show', process.argv[1] + ':package.json'], { encoding: 'utf8' }).replace(/^﻿/, '')) } catch (e) { console.log(String(e.message).split('\n')[0]); process.exit(1) }", $rev)
    if ($sp.code -ne 0) { $why = 'package.json at ' + $rev.Substring(0, 7) + ' is not valid JSON (node JSON.parse: ' + (Tail $sp.text 1) + ')' }
  }
  if (-not $why) { try { $pjOld = ConvertFrom-Json -InputObject $pkgOldShow.text } catch { $why = 'HEAD package.json does not parse: ' + (Clean $_.Exception.Message) } }
  if (-not $why) { try { $pjNew = ConvertFrom-Json -InputObject $pkgAt } catch { $why = 'target package.json does not parse: ' + (Clean $_.Exception.Message) } }
  if (-not $why -and -not ($pjOld -is [System.Management.Automation.PSCustomObject])) { $why = 'HEAD package.json is not a JSON object' }
  if (-not $why -and -not ($pjNew -is [System.Management.Automation.PSCustomObject])) { $why = 'target package.json is not a JSON object' }
  if ($why) { Stop-Golive (Dependency-Release ('package.json changed HEAD..target and ' + $why + '; it cannot be proved code-only, so it is treated as')) }
  # Install: what npm resolves, fetches, builds or refuses on. Start: Electron runs Quartz.exe on
  # this folder and reads main (the entry), type (how main loads), and name/productName (app.getName(),
  # which names the profile folder under %APPDATA% and the userData path).
  $installFields = @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
    'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'engines', 'os', 'cpu', 'libc',
    'workspaces', 'packageManager', 'main', 'type', 'name', 'productName')
  $names = @(@($pjOld.PSObject.Properties | ForEach-Object { $_.Name }) + @($pjNew.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object -Unique -CaseSensitive)
  $changed = @(); $blocked = @()
  try {
    foreach ($n in $names) {
      if ((Json-Canon $pjOld $n) -cne (Json-Canon $pjNew $n)) {
        $changed += $n
        if ($installFields -ccontains $n) { $blocked += $n }
      }
    }
  } catch { Stop-Golive (Dependency-Release ('package.json changed HEAD..target and comparing it failed (' + (Clean $_.Exception.Message) + '), so it is treated as')) }
  if ($blocked.Count) { Stop-Golive (Dependency-Release ('package.json changed install/start fields HEAD..target (' + ($blocked -join ', ') + ')')) }
  if ($changed.Count) {
    Pass ('preflight: package.json differs only in non-install fields (' + ($changed -join ', ') + '); ' + $lockNote + '; code-only release')
    # Lifecycle scripts are not run here (no npm), but the next npm install runs them: say so.
    if ($changed -ccontains 'scripts') {
      foreach ($s in @('preinstall', 'install', 'postinstall', 'prepare')) {
        $a = ''; $b = ''
        if ($pjOld.scripts) { $a = [string]$pjOld.scripts.$s }
        if ($pjNew.scripts) { $b = [string]$pjNew.scripts.$s }
        if ($a -cne $b) { Info ('preflight: scripts.' + $s + ' changed; not run by this script, the next npm install (lumen-golive.ps1) runs it') }
      }
    }
  } else { Pass 'preflight: package.json text differs but no top-level field changed when parsed (formatting only); ' + $lockNote + '; code-only release' }
}
$ev = ''
try { $ev = [string](Get-Content (Join-Path $Repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version } catch { $ev = '' }
if ($ev -match '\+wvcus$') { Pass ('preflight: electron here is ' + $ev) } else { Stop-Golive ('electron here is ' + $(if ($ev) { $ev } else { 'none' }) + ', not castlabs +wvcus') }
if (Test-Path (Join-Path $Dist 'Quartz.exe.sig')) { Pass 'preflight: Quartz.exe.sig exists (EVS-signed build)' } else { Stop-Golive 'Quartz.exe.sig is missing: the build is not signed' }
$tests = @(Test-Procs)
if ($tests.Count) { Stop-Golive ([string]$tests.Count + ' test instance(s) run from this checkout (PID ' + (($tests | ForEach-Object { $_.ProcessId }) -join ', ') + '); not going live under them') }
$exeBefore = Exe-Hash

# ---- 1. snapshots --------------------------------------------------------------------------
$regBefore = Reg-Snapshot
$regFile = Join-Path $StateDir ('registry-before-' + $stamp + '.txt')
[IO.File]::WriteAllText($regFile, $regBefore, (New-Object Text.UTF8Encoding($false)))
$quartzUrl = @($regBefore -split "`n" | Where-Object { $_ -match 'QuartzURL' })
Pass ('1. registry snapshot: ' + $quartzUrl.Count + ' QuartzURL value(s), saved to ' + $regFile)
$ptyBefore = Pty-Hash
if ($ptyBefore) { Pass ('1. node-pty native files hashed (' + (@($ptyBefore -split ';')).Count + ' .node files)') } else { Stop-Golive ('node-pty native files missing in ' + $PtyDir + ' (the terminal would break); not going live') }
$state = [ordered]@{ repo = $Repo; oldHead = $script:oldHead; target = $target; at = (Get-Date).ToString('o'); registry = $regFile; dryRun = [bool]$DryRun }
[IO.File]::WriteAllText((Join-Path $StateDir ('state-' + $stamp + '.json')), ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

# ---- 2. close Quartz cleanly ---------------------------------------------------------------
$main = @(Main-Procs)
if ($DryRun) {
  if ($main.Count) { Info ('2. would close main Quartz PID ' + (($main | ForEach-Object { $_.ProcessId }) -join ', ') + ' (CloseMainWindow, then wait); dry run: not closed') }
  else { Info ('2. no Quartz runs from ' + $Dist + '; nothing to close') }
  $live = @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $LiveExe -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--test-profile' })
  Info ('2. probe of the live checkout (read only): main Quartz PID ' + $(if ($live.Count) { ($live | ForEach-Object { $_.ProcessId }) -join ', ' } else { 'none' }) + ' is what the real run closes')
} else {
  if (-not $main.Count) { Pass '2. Quartz is not running from this checkout; nothing to close' }
  else {
    if ($main.Count -gt 1) { Info ('2. ' + $main.Count + ' main Quartz processes: ' + (($main | ForEach-Object { $_.ProcessId }) -join ', ')) }
    $deadline = (Get-Date).AddSeconds($CloseTimeoutSec)
    $closed = @{}
    while ((Get-Date) -lt $deadline) {
      $left = @(Main-Procs)
      if (-not $left.Count) { break }
      foreach ($m in $left) {
        $p = $null
        try { $p = Get-Process -Id $m.ProcessId -ErrorAction Stop } catch { $p = $null }
        if (-not $p) { continue }
        $h = [int64]$p.MainWindowHandle
        $key = [string]$m.ProcessId + ':' + $h
        if ($h -ne 0 -and -not $closed.ContainsKey($key)) {
          $closed[$key] = $true
          Say ('closing Quartz PID ' + $m.ProcessId + ' window ' + $h + ' (CloseMainWindow)')
          [void]$p.CloseMainWindow()
        }
      }
      Start-Sleep -Milliseconds 1000
    }
    $left = @(Main-Procs)
    if ($left.Count) { Stop-Golive ('Quartz PID ' + (($left | ForEach-Object { $_.ProcessId }) -join ', ') + ' did not exit within ' + $CloseTimeoutSec + ' s of CloseMainWindow; NOT killed. Close it by hand, then run this again') }
    Pass '2. main Quartz exited after CloseMainWindow'
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (@(Here-Procs | Where-Object { $_.CommandLine -notmatch '--test-profile' })).Count) { Start-Sleep -Milliseconds 500 }
  $rest = @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--test-profile' })
  if ($rest.Count) { Stop-Golive ('Quartz helper processes still run 30 s after the main one left (PID ' + (($rest | ForEach-Object { $_.ProcessId }) -join ', ') + '); NOT killed') }
  Pass '2. no Quartz process from this checkout is left'
}

# ---- 3. fast-forward -----------------------------------------------------------------------
if ($DryRun) {
  Info ('3. would run: git merge --ff-only ' + $Ref + ' (' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + '); dry run: the checkout is not touched')
} else {
  $ff = Run 'git' @('merge', '--ff-only', $Ref)
  if ($ff.code -ne 0) { Stop-Golive ('git merge --ff-only ' + $Ref + ' failed: ' + (Tail $ff.text 2)) }
  $script:merged = $true
  $now = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()
  if ($now -eq $target) { Pass ('3. HEAD is ' + $now.Substring(0, 7) + ' (' + $Ref + ')') } else { Stop-Golive ('HEAD is ' + $now.Substring(0, 7) + ' after the merge, not ' + $target.Substring(0, 7)) }
}

# ---- 4. CHECK ONLY: the signed castlabs build is untouched --------------------------------
$ev2 = ''
try { $ev2 = [string](Get-Content (Join-Path $Repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version } catch { $ev2 = '' }
if ($ev2 -match '\+wvcus$') { Pass ('4. electron is still ' + $ev2) } else { Stop-Golive ('electron is ' + $ev2 + ' after the fast-forward, not castlabs') }
$exeAfter = Exe-Hash
if ($exeAfter -eq $exeBefore -and $exeAfter -notmatch 'missing') { Pass '4. Quartz.exe and Quartz.exe.sig are byte-identical to before (the EVS signature still matches)' } else { Stop-Golive ('Quartz.exe or its .sig changed or went missing: ' + $exeAfter) }

# ---- 5. node-pty ---------------------------------------------------------------------------
$ptyAfter = Pty-Hash
if ($ptyAfter -and $ptyAfter -eq $ptyBefore) { Pass '5. node-pty native files are byte-identical to before' } else { Stop-Golive ('node-pty native files changed or went missing (before: ' + (@($ptyBefore -split ';')).Count + ' files, after: ' + $(if ($ptyAfter) { (@($ptyAfter -split ';')).Count } else { 0 }) + ')') }

# ---- 6. relaunch through the Start Menu shortcut -------------------------------------------
if (-not (Test-Path $Lnk)) { Stop-Golive ('the Start Menu shortcut is missing: ' + $Lnk) }
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
$want = (Join-Path $Dist 'Quartz.exe')
if ($DryRun) {
  Info ('6. would run: explorer.exe "' + $Lnk + '" (dry run: not launched)')
  if (Test-Path $sc.TargetPath) { Pass ('6. the shortcut targets ' + $sc.TargetPath + ' (exists)') } else { Fail ('6. the shortcut target is missing: ' + $sc.TargetPath) }
  if ($sc.TargetPath -ieq $want) { Pass '6. the shortcut targets this checkout' } else { Info ('6. the shortcut targets ' + $sc.TargetPath + ', not this checkout (expected for a worktree dry run)') }
} else {
  if ($sc.TargetPath -ine $want) { Stop-Golive ('the shortcut targets ' + $sc.TargetPath + ', not ' + $want) }
  $launchAt = Get-Date
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Lnk + '"')
  # The first start after the swap runs a freshly written, freshly signed dist that Defender scans
  # on first use: on this laptop that took over 45 s on 10-18 (main Quartz created 00:37:15, after
  # the old 45 s window had closed). Wait 120 s, and look once more before the verdict.
  $deadline = $launchAt.AddSeconds(120)
  while ((Get-Date) -lt $deadline -and -not @(Main-Procs).Count) { Start-Sleep -Milliseconds 500 }
  $up = @(Main-Procs)
  if ($up.Count) { Pass ('6. Quartz relaunched through the shortcut (PID ' + (($up | ForEach-Object { $_.ProcessId }) -join ', ') + ', ' + (Split-Path -Leaf $up[0].ExecutablePath) + ', up ' + [math]::Round(($up[0].CreationDate - $launchAt).TotalSeconds) + ' s after explorer.exe)') }
  else { Info '6. no main Quartz yet 120 s after explorer.exe on the shortcut; looked at again before the verdict' }
  Start-Sleep -Seconds 10   # let it finish starting before the registry is compared
}

# ---- 7. registry untouched -----------------------------------------------------------------
$regAfter = Reg-Snapshot
if ($regAfter -eq $regBefore) { Pass '7. QuartzURL / QuartzHTML / StartMenuInternet / RegisteredApplications / UserChoice untouched' }
else {
  $a = $regBefore -split "`n"; $b = $regAfter -split "`n"
  Fail ('7. the default-browser registry changed: ' + ((Compare-Object $a $b | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ' ; ') + ' (snapshot: ' + $regFile + ')')
}
# Step 6 again, when it saw no main Quartz in its 120 s: a late start is a start (with its time).
if (-not $DryRun -and $launchAt -and -not $up.Count) {
  $late = @(Main-Procs)
  if ($late.Count) { Pass ('6. Quartz started late (PID ' + (($late | ForEach-Object { $_.ProcessId }) -join ', ') + ', up ' + [math]::Round(($late[0].CreationDate - $launchAt).TotalSeconds) + ' s after explorer.exe)') }
  else { Fail ('6. Quartz did not start within ' + [math]::Round(((Get-Date) - $launchAt).TotalSeconds) + ' s of explorer.exe on the shortcut') }
}

# ---- 8. rollback -----------------------------------------------------------------------------
Rollback-Text
Write-Output ('ff-golive: verdict ' + $(if ($script:fails) { 'FAIL (' + $script:fails + ' failed)' } else { 'PASS' }) + $(if ($DryRun) { ' [dry run]' } else { '' }))
if ($script:fails) { exit 1 }
exit 0
