import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.join(__dirname, '..', '..', '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env is optional */
}

const PORT = process.env.API_PORT || '5174';
const CLIENT_URL = `http://localhost:${PORT}`;
const API_SERVER = path.join(__dirname, '..', '..', 'web', 'api-server.ts');

// The data service uses the built-in `node:sqlite` module, which is NOT present
// in Electron's bundled node. So the service must run under the system `node`.
function resolveNodeBin(): string {
  const candidates = [
    process.env.VELA_NODE,
    process.env.npm_node_execpath, // set by npm when launched via `npm run dev/start`
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(process.env.HOME || '', '.nvm/current/bin/node'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node'; // fall back to PATH lookup
}

app.setPath('userData', path.join(app.getPath('appData'), 'vela-client'));

let serverProc: ChildProcess | null = null;

function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(CLIENT_URL, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function startServer(): void {
  const nodeBin = resolveNodeBin();
  console.log('[api] launching data service via', nodeBin);
  serverProc = spawn(nodeBin, ['--experimental-strip-types', API_SERVER], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout?.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`));
  serverProc.stderr?.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
  serverProc.on('exit', (code) => console.log('[api] exited', code));
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Vela Client',
    backgroundColor: '#0b0e11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const ready = await waitForServer();
  if (!ready) {
    win.loadURL(
      `data:text/html,${encodeURIComponent(`<h2 style="font-family:sans-serif">无法启动本地数据服务(:${PORT})</h2>`)}`,
    );
    return;
  }
  win.loadURL(CLIENT_URL);
}

app.whenReady().then(() => {
  startServer();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProc) serverProc.kill();
});
