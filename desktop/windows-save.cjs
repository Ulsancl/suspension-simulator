const { spawn } = require('node:child_process');
const path = require('node:path');

// Windows PowerShell ships with Windows. File.Replace uses ReplaceFileW and
// refuses a metadata/ACL merge failure. The stage ACL is set at creation time.
const saveScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputRecord = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [string]$inputRecord.target
$expectedExisting = [bool]$inputRecord.expectedExisting
$parent = [IO.Path]::GetDirectoryName($target)
$stage = [IO.Path]::Combine($parent, '.suspension-save-' + [Guid]::NewGuid().ToString('N'))
$temporary = [IO.Path]::Combine($stage, 'project.tmp')
$backup = [IO.Path]::Combine($stage, 'original-project.json')
$reparsePoint = [IO.FileAttributes]::ReparsePoint
function Assert-RealDirectory([string]$directory) {
    while ($directory) {
        if ([IO.File]::GetAttributes($directory) -band $reparsePoint) { throw 'Invalid save directory' }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
}
$owned = $false
$published = $false
try {
    Assert-RealDirectory $parent
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Save staging name already exists' }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    $owned = $true
    Assert-RealDirectory $stage
    $stageAcl = [IO.Directory]::GetAccessControl($stage)
    $rules = $stageAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (!$stageAcl.AreAccessRulesProtected -or $stageAcl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $user -or
        $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $user -or $rules[0].FileSystemRights -ne 'FullControl') {
        throw 'Save staging directory must have a private ACL'
    }
    $stream = [IO.FileStream]::new($temporary, 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Convert]::FromBase64String($inputRecord.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $delays = @(25, 50, 100, 200, 400)
    for ($attempt = 0; ; $attempt++) {
        Assert-RealDirectory $stage
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch [IO.FileNotFoundException] {}
        if ($null -ne $attributes -and ($attributes -band ($reparsePoint -bor [IO.FileAttributes]::Directory))) {
            throw 'Invalid save destination'
        }
        if (($null -ne $attributes) -ne $expectedExisting) { throw 'Save destination changed' }
        try {
            if ($null -eq $attributes) { [IO.File]::Move($temporary, $target) }
            else { [IO.File]::Replace($temporary, $target, $backup, $false) }
            $published = $true
            break
        } catch {
            # Some ReplaceFileW failures can leave the original at the backup
            # path. Restore its name when possible, otherwise keep it private.
            if ([IO.File]::Exists($backup)) {
                if (![IO.File]::Exists($target) -and ![IO.Directory]::Exists($target)) {
                    try { [IO.File]::Move($backup, $target) } catch {}
                }
                throw
            }
            $code = $_.Exception.GetBaseException().HResult -band 65535
            if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33)) { throw }
            Start-Sleep -Milliseconds $delays[$attempt]
        }
    }
} finally {
    if ($owned) {
        Assert-RealDirectory $stage
        [IO.File]::Delete($temporary)
        if ($published) { [IO.File]::Delete($backup) }
        if ([IO.File]::Exists($backup)) { [Console]::Out.WriteLine([IO.Path]::GetFileName($stage)) }
        else { [IO.Directory]::Delete($stage) }
    }
}
`;

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsPowerShellEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  return { ...env, ...extra, PSModulePath: path.join(path.dirname(windowsPowerShell()), 'Modules') };
}

function windowsWriteProject(target, contents, expectedExisting) {
  const command = Buffer.from(saveScript, 'utf16le').toString('base64');
  // Base64 encodes the wire bytes so PowerShell's console encoding cannot
  // reinterpret a Unicode project or path. The fixed command reads only data.
  const payload = JSON.stringify({
    target,
    expectedExisting,
    contents: Buffer.from(contents, 'utf8').toString('base64'),
  }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return new Promise((resolve, reject) => {
    const executable = windowsPowerShell();
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      cwd: path.dirname(executable), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: windowsPowerShellEnv(),
    });
    let output = '';
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-128); });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else {
        const stage = output.trim();
        const backup = /^\.suspension-save-[a-f0-9]{32}$/.test(stage)
          ? path.join(path.dirname(target), stage, 'original-project.json') : null;
        reject(new Error(backup
          ? '프로젝트를 저장하지 못했습니다. 원래 파일은 다음 경로에 보관했습니다. ' + backup
          : '프로젝트를 저장하지 못했습니다. 대상 경로와 파일 권한을 확인해 주세요.'));
      }
    });
    child.stdin.end(payload);
  });
}

module.exports = { windowsPowerShell, windowsPowerShellEnv, windowsWriteProject };
