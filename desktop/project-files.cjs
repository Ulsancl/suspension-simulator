const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { windowsWriteProject } = require('./windows-save.cjs');

async function readBounded(handle, limit) {
  const chunks = [];
  let length = 0;
  while (length <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - length));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) return Buffer.concat(chunks, length);
    length += bytesRead;
    if (length > limit) break;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new Error('프로젝트 파일은 32 MiB 이하여야 합니다.');
}

function sameFile(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino;
}

async function openProjectFile(target, stat, recheck, limit) {
  const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    const current = await recheck(target);
    if (!opened.isFile() || opened.size > limit || !sameFile(opened, stat) || !sameFile(opened, current)) {
      throw new Error('프로젝트 파일이 변경되었습니다. 다시 선택해 주세요.');
    }
    return await readBounded(handle, limit);
  } finally {
    await handle.close();
  }
}

async function saveSiblingProjectFile(target, contents, recheck, temporary = target + '.' + randomUUID() + '.tmp') {
  const previous = await recheck(target, true);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await recheck(target, true);
    if (previous !== current && !sameFile(previous, current)) {
      throw new Error('저장 대상 파일이 변경되었습니다. 경로를 다시 선택해 주세요.');
    }
    await fsp.rename(temporary, target);
    published = true;
  } finally {
    if (!published) await fsp.unlink(temporary).catch(() => {});
  }
}

async function saveProjectFile(target, contents, recheck) {
  if (process.platform !== 'win32') return saveSiblingProjectFile(target, contents, recheck);
  const previous = await recheck(target, true);
  return windowsWriteProject(target, contents, previous != null);
}

module.exports = { readBounded, openProjectFile, saveProjectFile, saveSiblingProjectFile };
