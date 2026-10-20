const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.API_PORT || 5174;
const CLIENT_URL = `http://localhost:${PORT}`;
const API_SERVER = path.join(__dirname, '..', 'demo', 'api-server.mjs');

// The data service uses the built-in `node:sqlite` module, which is NOT present
// in Electron's bundled node. So the service must run under the system `node`.
function resolveNodeBin() {
  const candidates = [
    process.env.VELA_NODE,
    process.env.npm_node_execpath, // set by npm when launched via `npm run dev/start`
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(process.env.HOME || '', '.nvm/current/bin/node'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'node'; // fall back to PATH lookup
}

app.setPath('userData', path.join(app.getPath('appData'), 'vela-client'));

let serverProc = null;

function ping() {
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

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startServer() {
  const nodeBin = resolveNodeBin();
  console.log('[api] launching data service via', nodeBin);
  serverProc = spawn(nodeBin, [API_SERVER], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => process.stdout.write('[api] ' + d));
  serverProc.stderr.on('data', (d) => process.stderr.write('[api] ' + d));
  serverProc.on('exit', (code) => console.log('[api] exited', code));
}

async function createWindow() {
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
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const ready = await waitForServer();
  if (!ready) {
    win.loadURL(
      'data:text/html,' +
        encodeURIComponent('<h2 style="font-family:sans-serif">无法启动本地数据服务(:' + PORT + ')</h2>'),
    );
    return;
  }
  win.loadURL(CLIENT_URL);
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProc) serverProc.kill();
});
