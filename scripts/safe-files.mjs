import fs from 'node:fs';
import path from 'node:path';

function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path escaped the workspace');
  return relative;
}

export function checkedPath(root, file) {
  root = path.resolve(root); file = path.resolve(file);
  const relative = inside(root, file);
  let current = root;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Symlinks and special files are not allowed: ' + current);
    if (fs.realpathSync(current) !== current) throw new Error('Non-canonical input path: ' + current);
  }
  return file;
}

export function readInput(root, file) {
  file = checkedPath(root, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd), current = fs.lstatSync(checkedPath(root, file));
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('Input changed while opening');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function checkTree(root, directory) {
  checkedPath(root, directory);
  if (fs.statSync(directory).isDirectory()) for (const name of fs.readdirSync(directory)) checkTree(root, path.join(directory, name));
}

export function secureDirectory(root, directory) {
  root = path.resolve(root); directory = path.resolve(directory);
  const relative = inside(root, directory);
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkedPath(root, current);
    const info = fs.statSync(current);
    if (!info.isDirectory()) throw new Error('Output parent must be a directory');
    // A distinct local user must not be able to swap verified output parents.
    if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022))) throw new Error('Output directory must be owned by this user and not writable by other users');
  }
  return directory;
}

export function stagingDirectory(root) {
  secureDirectory(root, root);
  return fs.mkdtempSync(path.join(root, '.security-stage-'));
}

export function writeArtifact(root, file, data) {
  const parent = secureDirectory(root, path.dirname(file));
  if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) checkedPath(root, file);
  const stage = fs.mkdtempSync(path.join(parent, '.security-write-'));
  try {
    const temporary = path.join(stage, 'artifact');
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    secureDirectory(root, parent);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function copyInput(root, source, target) {
  checkedPath(root, source);
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) copyInput(root, path.join(source, name), path.join(target, name));
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, readInput(root, source), { flag: 'wx', mode: fs.statSync(source).mode & 0o777 });
  }
}

export function publishDirectory(root, source, target) {
  secureDirectory(root, path.dirname(target));
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    checkTree(root, target);
    // Keep the previous generated result until the new one is published.
    const backup = path.join(path.dirname(source), 'previous');
    fs.renameSync(target, backup);
    try { fs.renameSync(source, target); } catch (error) { fs.renameSync(backup, target); throw error; }
    fs.rmSync(backup, { recursive: true });
  } else fs.renameSync(source, target);
}

export function artifactDirectory(root, destination) {
  destination = path.resolve(root, destination);
  secureDirectory(root, path.dirname(destination));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) checkTree(root, destination);
  const stage = stagingDirectory(root), output = path.join(stage, 'artifacts');
  fs.mkdirSync(output, { mode: 0o700 });
  process.once('exit', () => { publishDirectory(root, output, destination); fs.rmdirSync(stage); });
  return output;
}
