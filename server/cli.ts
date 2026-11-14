import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApiMiddleware, PROJECT_FILE } from './api';
import { version } from '../package.json';

/**
 * Standalone entry point: serves the built UI and the local API from one process.
 *   localcloud-studio [projectDir] [--port 5173] [--open]
 * The project file and terraform-out/ are read from and written to projectDir (default: cwd).
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function parseArgs(argv: string[]) {
  const args = { projectDir: process.cwd(), port: 5173, open: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (!arg.startsWith('-')) args.projectDir = path.resolve(arg);
    else {
      console.error(`Unknown option: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.version) {
  console.log(version);
  process.exit(0);
}
if (args.help || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
  console.log(`Usage: localcloud-studio [projectDir] [--port 5173] [--open] [--version]

Serves LocalCloud Studio for one project directory. The canvas is saved to
<projectDir>/${PROJECT_FILE} and Terraform is written to <projectDir>/terraform-out/.`);
  process.exit(args.help ? 0 : 1);
}

// Bundled to dist-server/cli.cjs; the built UI sits next to it in dist/
const staticDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
  console.error(`Built UI not found at ${staticDir}. Run "npm run build" first.`);
  process.exit(1);
}
fs.mkdirSync(args.projectDir, { recursive: true });

const api = createApiMiddleware({ projectDir: args.projectDir });

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  let filePath = path.resolve(staticDir, `.${pathname}`);
  const inside = filePath === staticDir || filePath.startsWith(staticDir + path.sep);
  if (!inside || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(staticDir, 'index.html');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  // Hashed assets never change; index.html must always be fresh
  res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => api(req, res, () => serveStatic(req, res)));

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${args.port} is already in use. Try --port <n>.` : err.message);
  process.exit(1);
});

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${args.port}`;
  console.log(`LocalCloud Studio ${version}  ${url}`);
  console.log(`Project            ${path.join(args.projectDir, PROJECT_FILE)}`);
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
