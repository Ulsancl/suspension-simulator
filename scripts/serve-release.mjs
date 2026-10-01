import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(path.join(directory, fs.existsSync(path.join(directory, 'app')) ? 'app' : '../dist'));
const port = Number(process.env.SUSPENSION_PORT || 5175);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SUSPENSION_PORT must be 1024–65535');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.txt':'text/plain; charset=utf-8' };
const within = candidate => candidate === root || candidate.startsWith(root + path.sep);
const server = http.createServer((request, response) => {
  const finish = (status, text) => { response.writeHead(status, { 'Content-Type':'text/plain; charset=utf-8', 'X-Content-Type-Options':'nosniff' }); response.end(text); };
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); return finish(405, 'Method not allowed'); }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let candidate = path.resolve(root, '.' + pathname);
    if (!within(candidate) || pathname.includes('\0')) return finish(403, 'Forbidden');
    if (pathname.endsWith('/')) candidate = path.join(candidate, 'index.html');
    if (!fs.existsSync(candidate)) return finish(404, 'Not found');
    const actual = fs.realpathSync(candidate);
    if (!within(actual) || !fs.statSync(actual).isFile()) return finish(403, 'Forbidden');
    const stat = fs.statSync(actual);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(actual)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': /[\\/]assets[\\/]/.test(actual) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(actual).on('error', () => response.destroy()).pipe(response);
  } catch (error) { return finish(error instanceof URIError ? 400 : 404, 'Invalid path'); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set SUSPENSION_PORT to another port.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Suspension Lab: http://127.0.0.1:${port}/\nKeep this terminal open. Press Ctrl+C to stop.`));
