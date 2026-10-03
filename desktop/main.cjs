const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const APP_URL = 'app://suspension/';
const APP_NAME = 'Suspension Lab';
const MAX_PROJECT_BYTES = 40 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
let mainWindow, calculationBusy = false, nativeBusy = 0, closePrompt = false;
const downloads = new Set();

app.setName(APP_NAME);
// Keep the data directory and origin stable when a new version is installed.
const profileOverride = process.env.SUSPENSION_LAB_DATA_DIR;
if (profileOverride && !path.isAbsolute(profileOverride)) throw new Error('SUSPENSION_LAB_DATA_DIR must be absolute');
app.setPath('userData', profileOverride || path.join(app.getPath('appData'), APP_NAME));
fs.mkdirSync(app.getPath('userData'), { recursive: true });

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function log(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* Logging must not prevent launch. */ }
}
function trustedURL(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.host === 'suspension' && !url.username && !url.password; } catch { return false; }
}
function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedURL(event.senderFrame?.url)) throw new Error('Invalid application sender');
}
function command(value) { mainWindow?.webContents.send('suspension:command', value); }
function saveResult(value) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('suspension:save-result', value); }
function safeFileName(value) {
  let name = path.basename(typeof value === 'string' ? value : 'suspension-project.suspension.json')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `suspension-${name}`;
  return name || 'suspension-project.suspension.json';
}

function projectText(contents) {
  if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_PROJECT_BYTES) {
    throw new Error('프로젝트 파일은 40 MiB 이하인 JSON 텍스트여야 합니다.');
  }
  let parsed;
  try { parsed = JSON.parse(contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents); }
  catch { throw new Error('JSON 프로젝트 파일을 읽을 수 없습니다. 원본 파일은 변경하지 않습니다.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type !== 'suspension-lab-project') {
    throw new Error('지원하지 않는 프로젝트 파일입니다. 원본 파일은 변경하지 않습니다.');
  }
  return contents;
}

async function projectTarget(target, allowMissing = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('프로젝트 파일의 절대 경로를 확인해 주세요.');
  const parent = path.dirname(target), realParent = await fsp.realpath(parent);
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(parent) !== normalized(realParent)) throw new Error('연결된 폴더 대신 원래 프로젝트 폴더를 선택해 주세요.');
  let stat;
  try { stat = await fsp.lstat(target); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('폴더나 연결 파일 대신 일반 JSON 파일을 선택해 주세요.');
  return stat;
}

async function serveBundle(request) {
  if (!trustedURL(request.url)) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  try {
    const root = path.join(app.getAppPath(), 'dist');
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || pathname.includes('\0')) return new Response('Forbidden', { status: 403 });
    const actual = await fsp.realpath(target);
    const actualRelative = path.relative(root, actual);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) return new Response('Forbidden', { status: 403 });
    const data = await fsp.readFile(actual);
    return new Response(request.method === 'HEAD' ? null : data, { headers: {
      'Content-Type': mime[path.extname(actual)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}

function registerFileActions() {
  ipcMain.on('suspension:busy', (event, busy) => { try { trustedSender(event); calculationBusy = busy === true; } catch { /* Ignore unrelated frames. */ } });
  ipcMain.handle('suspension:open-project', async event => {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    nativeBusy++;
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: '서스펜션 프로젝트 열기', properties: ['openFile'], filters: [{ name: '서스펜션 프로젝트', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      const target = result.filePaths[0], stat = await projectTarget(target);
      if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일은 40 MiB 이하인 JSON 파일이어야 합니다.');
      const handle = await fsp.open(target, 'r');
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_PROJECT_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error('프로젝트 파일이 변경되었습니다. 다시 선택해 주세요.');
        }
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      if (bytes.byteLength > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일은 40 MiB 이하여야 합니다.');
      return { canceled: false, content: projectText(bytes.toString('utf8')), path: target };
    } finally { nativeBusy--; }
  });
  ipcMain.handle('suspension:save-project', async (event, payload) => {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    if (!payload || typeof payload !== 'object') throw new Error('프로젝트 파일 내용을 확인해 주세요.');
    nativeBusy++;
    let temporary;
    try {
      const contents = projectText(payload.contents);
      const result = await dialog.showSaveDialog(mainWindow, { title: '서스펜션 프로젝트 저장', defaultPath: path.join(app.getPath('documents'), safeFileName(payload.name)), filters: [{ name: '서스펜션 프로젝트', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      await projectTarget(result.filePath, true);
      temporary = `${result.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await fsp.rename(temporary, result.filePath);
      temporary = null;
      return { canceled: false, path: result.filePath };
    } finally {
      if (temporary) await fsp.unlink(temporary).catch(() => {});
      nativeBusy--;
    }
  });
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '파일', submenu: [
      { label: '새 프로젝트', accelerator: 'CmdOrCtrl+N', click: () => command('new-project') },
      { label: '프로젝트 열기…', accelerator: 'CmdOrCtrl+O', click: () => command('open-project') },
      { label: '프로젝트 저장…', accelerator: 'CmdOrCtrl+S', click: () => command('save-project') },
      { type: 'separator' }, { label: '종료', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
    ] },
    { label: '편집', submenu: [{ label: '실행 취소', role: 'undo' }, { label: '다시 실행', role: 'redo' }, { type: 'separator' }, { label: '잘라내기', role: 'cut' }, { label: '복사', role: 'copy' }, { label: '붙여넣기', role: 'paste' }, { label: '전체 선택', role: 'selectAll' }] },
    { label: '보기', submenu: [{ label: '실험대', click: () => command('view-bench') }, { label: '응답 분석', click: () => command('view-analysis') }, { label: '실험 기록', click: () => command('view-experiments') }, { label: '실측 검증', click: () => command('view-validation') }, { type: 'separator' }, { label: '실제 크기', role: 'resetZoom' }, { label: '확대', role: 'zoomIn' }, { label: '축소', role: 'zoomOut' }, { label: '전체 화면', role: 'togglefullscreen' }] },
    { label: '도움말', submenu: [
      { label: '사용 안내', click: () => command('help') },
      { label: '저장 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
      { label: '프로그램 정보', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: APP_NAME, message: `${APP_NAME} ${app.getVersion()}`, detail: '서스펜션 수직 응답 · 3D 실험 · 기록 비교\n\n설정과 보관 기록은 이 앱에 자동 저장됩니다. 프로젝트 JSON으로 백업할 수 있습니다.\n\n모델: quarter-car-1.3 (수직 단일 휠 축약모델)', buttons: ['확인'] }) },
    ] },
  ]));
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8')); } catch { /* First launch. */ }
  mainWindow = new BrowserWindow({
    width: Math.min(Number(saved.width) || 1440, area.width), height: Math.min(Number(saved.height) || 1000, area.height),
    minWidth: Math.min(960, area.width), minHeight: Math.min(640, area.height),
    title: APP_NAME, show: false, backgroundColor: '#14191e', icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!trustedURL(url)) event.preventDefault(); });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    calculationBusy = false;
    log(`Renderer ended: ${details.reason}`);
    dialog.showMessageBox(mainWindow, { type: 'error', title: APP_NAME, message: '화면을 계속 표시하지 못했습니다.', detail: '저장된 기록은 유지됩니다. 프로그램을 다시 시작해 주세요.', buttons: ['확인'] });
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`Load failed: ${code} ${description} ${url}`);
    dialog.showErrorBox(APP_NAME, '프로그램 파일을 읽지 못했습니다. 설치 파일로 다시 설치해 주세요.');
    app.quit();
  });
  mainWindow.once('ready-to-show', () => { if (saved.maximized) mainWindow.maximize(); mainWindow.show(); });
  mainWindow.on('close', event => {
    if (calculationBusy || nativeBusy || downloads.size) {
      event.preventDefault();
      if (closePrompt) return;
      closePrompt = true;
      dialog.showMessageBox(mainWindow, { type: 'warning', title: '작업 진행 중', message: '시험 계산 또는 파일 작업이 진행 중입니다.', detail: '작업이 끝난 후 창을 닫아 주세요. 진행 중인 작업을 중단하고 종료할 수도 있습니다.', buttons: ['작업 계속', '작업 중단 후 종료'], defaultId: 0, cancelId: 0, noLink: true }).then(({ response }) => { closePrompt = false; if (response === 1) app.exit(0); }).catch(() => { closePrompt = false; });
      return;
    }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() })); } catch { /* Window layout is optional. */ }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  createMenu();
  mainWindow.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle('app', serveBundle);
    // All application content ships in the installer, including the first launch.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.on('will-download', (_event, item, contents) => {
      if (!mainWindow || contents !== mainWindow.webContents) { item.cancel(); return; }
      downloads.add(item);
      item.setSaveDialogOptions({ title: '결과 파일 저장', defaultPath: path.join(app.getPath('documents'), safeFileName(item.getFilename())) });
      item.once('done', (_event, state) => {
        downloads.delete(item);
        saveResult(state === 'completed' ? { path: item.getSavePath() } : state === 'cancelled' ? { canceled: true } : { error: '파일 저장을 완료하지 못했습니다.' });
      });
    });
    registerFileActions();
    createWindow();
    log(`Started ${app.getVersion()}`);
  }).catch(error => { log(`Startup failed: ${error.stack}`); dialog.showErrorBox(APP_NAME, `프로그램을 시작하지 못했습니다.\n${error.message}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
