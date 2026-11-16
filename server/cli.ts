import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApiMiddleware, PROJECT_FILE } from './api';
import { DbReady, createSql } from './db';
import { runMcpServer } from './mcp';
import { runTestCommand } from './testCommand';
import { version } from '../package.json';

/**
 * Standalone entry point: serves the built UI and the local API from one process.
 *   localcloud-studio [projectDir] [--port 5173] [--db <postgres-url>] [--open]
 *   localcloud-studio mcp [--url http://127.0.0.1:5173] [--project <dir-or-id>] [--token <t>]
 *   localcloud-studio test [projectDir] [--env dev] [--scenario <name>] [--port 9398] [--keep] [--verbose]
 * The project's working dir (localcloud.json, terraform-out/) is projectDir (default: cwd);
 * designs, history and runs live in Postgres at --db / $DATABASE_URL.
 */

// The MCP server speaks stdio to an agent and HTTP to the backend above; it never returns.
if (process.argv[2] === 'mcp') {
  runMcpServer(process.argv.slice(3)).catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
} else if (process.argv[2] === 'test') {
  // Deploy to a fresh emulator, run the saved scenarios, destroy: for CI. No database needed.
  runTestCommand(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack || err);
      process.exit(2);
    }
  );
} else {
// ───────────────────────────────────────────────────────────────────────────── web server mode

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
  const args = {
    projectDir: process.cwd(),
    port: 5173,
    host: process.env.LOCALCLOUD_BIND || '127.0.0.1',
    open: false,
    help: false,
    version: false,
    databaseUrl: process.env.DATABASE_URL || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') args.host = argv[++i] || args.host;
    else if (arg.startsWith('--host=')) args.host = arg.slice('--host='.length);
    else if (arg === '--db') args.databaseUrl = argv[++i] || '';
    else if (arg.startsWith('--db=')) args.databaseUrl = arg.slice('--db='.length);
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
  console.log(`Usage: localcloud-studio [projectDir] [--port 5173] [--host 127.0.0.1] [--db <postgres-url>] [--open] [--version]

Serves LocalCloud Studio for one project working directory. Designs, history and runs
are stored in Postgres (--db or $DATABASE_URL); the canvas is also materialized to
<projectDir>/${PROJECT_FILE} and Terraform is written to <projectDir>/terraform-out/.

Quick start:  docker compose up -d postgres
              DATABASE_URL=postgres://localcloud:localcloud@127.0.0.1:5432/localcloud localcloud-studio ./infra --open`);
  process.exit(args.help ? 0 : 1);
}
if (!args.databaseUrl) {
  console.error(`No database configured. Designs and history live in Postgres:

  docker compose up -d postgres   # or use your own Postgres
  DATABASE_URL=postgres://localcloud:localcloud@127.0.0.1:5432/localcloud localcloud-studio ...`);
  process.exit(1);
}

// Bundled to dist-server/cli.cjs; the built UI sits next to it in dist/
const staticDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
  console.error(`Built UI not found at ${staticDir}. Run "npm run build" first.`);
  process.exit(1);
}
fs.mkdirSync(args.projectDir, { recursive: true });

const sql = createSql(args.databaseUrl);
// Fail fast on an unreachable database or pending migrations, before the port opens
new DbReady(sql).once().catch((err) => {
  console.error(`Cannot reach Postgres at the configured DATABASE_URL: ${err.message}`);
  process.exit(1);
});

const api = createApiMiddleware({ databaseUrl: args.databaseUrl, defaultProjectDir: args.projectDir });

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

// 0.0.0.0 is only safe inside a container whose ports are published to the host's loopback
server.listen(args.port, args.host, () => {
  const url = `http://127.0.0.1:${args.port}`;
  console.log(`LocalCloud Studio ${version}  ${url}`);
  console.log(`Project folder     ${args.projectDir} (${PROJECT_FILE}, terraform-out/)`);
  console.log(`Database          ${args.databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
}
