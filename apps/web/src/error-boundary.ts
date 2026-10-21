const OVERLAY_ID = 'vela-fatal-error';

declare global {
  interface Window {
    __velaErrorBoundaryInstalled?: boolean;
  }
}

function showFatal(detail: string): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'alert');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex',
    'align-items:center', 'justify-content:center', 'padding:24px',
    'background:#0b0e11', 'color:#e6e9ef', 'font:14px/1.6 system-ui,sans-serif',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = 'max-width:560px;width:100%;background:#151a21;border:1px solid #2a323d;border-radius:12px;padding:24px';

  const title = document.createElement('h1');
  title.textContent = '界面遇到异常';
  title.style.cssText = 'margin:0 0 8px;font-size:18px';

  const detailEl = document.createElement('p');
  detailEl.textContent = detail;
  detailEl.style.cssText = 'margin:0 0 16px;color:#9aa4b2;word-break:break-word';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '重新加载';
  reload.style.cssText = 'padding:8px 16px;border-radius:8px;border:0;background:#3b82f6;color:#fff;cursor:pointer';
  reload.addEventListener('click', () => window.location.reload());

  panel.append(title, detailEl, reload);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

export function installErrorBoundary(): void {
  if (window.__velaErrorBoundaryInstalled) return;
  window.__velaErrorBoundaryInstalled = true;

  window.addEventListener('error', (event) => {
    console.error('[fatal] uncaught error', event.error ?? event.message);
    showFatal(event.error?.message ?? event.message ?? '未知错误');
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[fatal] unhandled rejection', event.reason);
    showFatal(event.reason?.message ?? String(event.reason ?? '未知错误'));
  });
}

installErrorBoundary();
