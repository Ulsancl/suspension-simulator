import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

export async function verifyFuses(executable, inspector) {
  const wire = await getCurrentFuseWire(executable);
  for (const [name, enabled] of Object.entries({
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: inspector,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  })) {
    if (wire[FuseV1Options[name]] !== (enabled ? 0x31 : 0x30)) {
      throw new Error('Unexpected fuse setting: ' + name);
    }
  }
}

export function verifyAuthenticode(executable, installer, signerHash) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot) || !/^[a-f0-9]{64}$/i.test(signerHash)) {
    throw new Error('A Windows system directory and approved signer SHA-256 are required');
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'foreach ($file in @($env:SUSPENSION_SIGNED_APP, $env:SUSPENSION_SIGNED_INSTALLER)) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $file',
    "  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or !$signature.TimeStamperCertificate) {",
    '    throw ("Valid timestamped Authenticode signature required: " + $signature.Status)',
    '  }',
    '  $sha256 = [System.Security.Cryptography.SHA256]::Create()',
    '  try { $digest = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace("-", "") }',
    '  finally { $sha256.Dispose() }',
    '  if ($digest -ne $env:SUSPENSION_SIGNER_SHA256) { throw "Unexpected Authenticode signer" }',
    '}',
  ].join('\n');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    env: { ...process.env, SUSPENSION_SIGNED_APP: executable, SUSPENSION_SIGNED_INSTALLER: installer, SUSPENSION_SIGNER_SHA256: signerHash },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Authenticode verification failed');
}
