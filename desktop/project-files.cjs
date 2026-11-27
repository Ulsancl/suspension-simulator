const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

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

async function openProjectFile(target, stat, recheck, limit) {
  const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    const current = await recheck(target);
    const sameFile = expected => opened.dev === expected.dev && opened.ino === expected.ino;
    if (!opened.isFile() || opened.size > limit || !sameFile(stat) || !sameFile(current)) {
      throw new Error('프로젝트 파일이 변경되었습니다. 다시 선택해 주세요.');
    }
    return await readBounded(handle, limit);
  } finally {
    await handle.close();
  }
}

async function saveProjectFile(target, contents, recheck, temporary = target + '.' + randomUUID() + '.tmp') {
  await recheck(target, true);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
    await recheck(target, true);
    await fsp.rename(temporary, target);
    published = true;
  } finally {
    if (!published) await fsp.unlink(temporary).catch(() => {});
  }
}

module.exports = { readBounded, openProjectFile, saveProjectFile };
