import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJSON = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const outputDirectory = path.join(root, 'release');
const output = path.join(outputDirectory, `Suspension-Lab-${packageJSON.version}-preview.zip`);
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(packageJSON.version)) throw new Error('Invalid release version');
if (!fs.existsSync(path.join(dist, 'asset-manifest.json'))) throw new Error('Run npm run build first');
if (fs.existsSync(outputDirectory) && fs.lstatSync(outputDirectory).isSymbolicLink()) throw new Error('Release directory must remain in the workspace');
fs.mkdirSync(outputDirectory, { recursive:true });
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Release output cannot be a symlink');

const entries = [];
function addDirectory(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes:true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlinks are not included in releases');
    if (entry.isDirectory()) addDirectory(file, prefix + entry.name + '/');
    else entries.push({ name:prefix + entry.name, data:fs.readFileSync(file) });
  }
}
addDirectory(dist, 'app/');
// README illustrations retain their source-relative paths in the optional ZIP.
addDirectory(path.join(root, 'public', 'screenshots'), 'public/screenshots/');
const documentFiles=['README.md', 'docs/model.md', 'docs/consumer-release.md', 'docs/storage-recovery.md', 'docs/engineering-release.md', 'docs/THIRD-PARTY-NOTICES.md', 'docs/product-validation.md', 'docs/design-validation.md', 'docs/dashboard-validation.md', 'docs/dashboard-design.md', 'docs/desktop-release.md'];
const evidenceFiles=new Set();
for (const file of documentFiles) {
  const data=fs.readFileSync(path.join(root,file));entries.push({name:file,data});
  for(const match of data.toString('utf8').matchAll(/\]\(((?:\.\.\/)?output\/[^)]+)\)/g)) {
    const actual=path.resolve(root,path.dirname(file),match[1]);
    if(!actual.startsWith(path.join(root,'output')+path.sep))throw new Error('Evidence must stay inside the workspace output directory');
    evidenceFiles.add(path.relative(root,actual).replaceAll('\\','/'));
  }
}
for(const file of [...evidenceFiles].sort())entries.push({name:file,data:fs.readFileSync(path.join(root,file))});
entries.push({ name:'serve.mjs', data:fs.readFileSync(path.join(root, 'scripts/serve-release.mjs')) });
entries.push({ name:'start.cmd', data:Buffer.from('@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (echo Node.js is required. & pause & exit /b 1)\r\nstart "" "http://127.0.0.1:5175/"\r\nnode serve.mjs\r\npause\r\n') });
entries.push({ name:'HOW-TO.txt', data:Buffer.from(`Suspension Lab ${packageJSON.version} engineering preview\r\n\r\nExtract the complete ZIP. Install Node.js if necessary, then double-click start.cmd or run: node serve.mjs\r\nOpen http://127.0.0.1:5175/ and keep the terminal open. No npm install is needed.\r\nUse the same browser and origin to retain its IndexedDB experiment library. Export project JSON for backups and transfer.\r\nThe app can work offline after the first successful load and cache installation. Browser installation availability varies.\r\nThis reduced vertical model is not yet validated for a specific production vehicle. Read docs/model.md and docs/engineering-release.md before engineering use.\r\nThe app/ directory may also be hosted at the root of an HTTPS website. Preserve THREE-LICENSE.txt.\r\n`) });

// Store ZIP entries without adding a packaging dependency. Filenames are UTF-8.
const table = Uint32Array.from({ length:256 }, (_, n) => { let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0; });
function crc32(data) { let crc=0xffffffff;for(const byte of data)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0; }
const local = [], central = [];
let offset=0;
for (const entry of entries) {
  const name=Buffer.from(entry.name,'utf8'),size=entry.data.length,crc=crc32(entry.data);
  if (size>0xffffffff || offset>0xffffffff) throw new Error('ZIP64 is not supported');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(size,18);header.writeUInt32LE(size,22);header.writeUInt16LE(name.length,26);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(33,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(size,20);record.writeUInt32LE(size,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
  local.push(header,name,entry.data);central.push(record,name);offset+=header.length+name.length+size;
}
const centralSize=central.reduce((sum,item)=>sum+item.length,0),end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
fs.writeFileSync(output,Buffer.concat([...local,...central,end]));
const checksum = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
const checksumFile = output + '.sha256';
if (fs.existsSync(checksumFile) && fs.lstatSync(checksumFile).isSymbolicLink()) throw new Error('Checksum output cannot be a symlink');
fs.writeFileSync(checksumFile, `${checksum}  ${path.basename(output)}\n`);
console.log(`Packaged ${entries.length} files: ${output} (${fs.statSync(output).size.toLocaleString()} bytes)`);
