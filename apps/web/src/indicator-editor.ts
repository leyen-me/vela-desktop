// Custom-indicator editor + chart hooks.
//
//   • The indicator library (Vela fork) dispatches `vela-indicator-new/-edit/-delete`
//     DOM events; we open the editor here.
//   • A legend-row action (the pencil beside an indicator's title) opens the same
//     editor for the running indicator and re-runs it in place on save.
//
// The editor is CodeMirror 6 with a small Pine StreamLanguage — line numbers, bracket
// matching / auto-close, auto-indent, active-line, multi-cursor, undo/redo, Ctrl+F
// search, and the One Dark theme. Persistence is local: user scripts in
// /api/v1/custom-indicators, bundled vault scripts edited in place via /api/v1/indicators/source.
import { basicSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage, indentUnit } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';
import { registerLegendAction } from '@luxalgo/vela/workspace';

import { api } from './api.ts';

const CUSTOM_API = '/custom-indicators';
const BUNDLED_API = '/indicators/source';

const KEYWORDS = new Set([
  'indicator', 'strategy', 'library', 'import', 'export', 'if', 'else', 'for', 'while', 'switch',
  'var', 'varip', 'to', 'by', 'and', 'or', 'not', 'in', 'break', 'continue', 'return', 'type',
]);
const CONSTS = new Set(['na', 'true', 'false']);
const TYPES = new Set([
  'series', 'simple', 'const', 'input', 'float', 'int', 'bool', 'string', 'color', 'line', 'label',
  'table', 'box', 'array', 'matrix', 'map', 'linefill', 'polyline', 'chart', 'plot', 'hline', 'fill',
]);

// Style-name → highlight tag (streamed tokens are mapped through this).
const tokenTable = {
  comment: t.comment,
  string: t.string,
  number: t.number,
  keyword: t.keyword,
  bool: t.bool,
  type: t.typeName,
  func: t.function(t.variableName),
  varName: t.variableName,
  operator: t.operator,
  punctuation: t.punctuation,
};

const pine = StreamLanguage.define({
  name: 'pine',
  tokenTable,
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { while (!stream.eol()) { if (stream.match('*/')) break; stream.next(); } return 'comment'; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^\d[\d._eE]*/)) return 'number';
    const ch = stream.peek();
    if (ch && /[A-Za-z_]/.test(ch)) {
      const start = stream.pos;
      stream.match(/^[A-Za-z_][\w.]*/);
      const word = stream.string.slice(start, stream.pos);
      if (KEYWORDS.has(word)) return 'keyword';
      if (CONSTS.has(word)) return 'bool';
      if (TYPES.has(word)) return 'type';
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return 'func';
      return 'varName';
    }
    if (ch && /[=+\-*/%<>!&|?:]/.test(ch)) { stream.next(); return 'operator'; }
    stream.next();
    return 'punctuation';
  },
});

const DEFAULT_SCRIPT = '//@version=6\nindicator("我的指标", overlay=true)\nplot(ta.ema(close, 20), color=color.orange)\n';

const CSS = `
.ci-backdrop { position: fixed; inset: 0; z-index: 2147483600; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
.ci-dialog { width: min(900px, 94vw); height: min(720px, 90vh); display: flex; flex-direction: column;
  background: #1e222d; color: #d1d4dc; border: 1px solid #363a45; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.6); overflow: hidden; }
.ci-head { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid #2a2b30; }
.ci-title { flex: 1; font-size: 16px; font-weight: 600; color: #fff; }
.ci-x { all: unset; cursor: pointer; color: #888; font-size: 18px; padding: 2px 8px; border-radius: 6px; }
.ci-x:hover { color: #fff; background: rgba(255,255,255,.08); }
.ci-body { flex: 1; display: flex; flex-direction: column; gap: 12px; padding: 16px 18px; min-height: 0; }
.ci-name { height: 38px; padding: 0 12px; background: #14161c; color: #fff; border: 1px solid #363a45; border-radius: 8px; font-size: 14px; outline: none; }
.ci-name:focus { border-color: #4b5563; }
.ci-editor { position: relative; flex: 1; min-height: 0; border: 1px solid #363a45; border-radius: 8px; overflow: hidden; }
.ci-editor .cm-editor { height: 100%; }
.ci-editor .cm-scroller { font: 13px/1.5 "SF Mono", Menlo, Consolas, monospace; }
.ci-foot { display: flex; gap: 10px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid #2a2b30; }
.ci-btn { height: 36px; padding: 0 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;
  border: 1px solid #363a45; background: transparent; color: #d1d4dc; }
.ci-btn:hover { background: rgba(255,255,255,.06); }
.ci-btn.primary { background: #fff; color: #0b0e11; border-color: #fff; }
.ci-btn.primary:hover { background: #e6e6e6; }
.ci-btn[disabled] { opacity: .75; cursor: default; }
.ci-spin { width: 14px; height: 14px; border: 2px solid rgba(0,0,0,.25); border-top-color: #0b0e11; border-radius: 50%; display: inline-block; animation: ci-spin .7s linear infinite; vertical-align: -2px; }
@keyframes ci-spin { to { transform: rotate(360deg); } }
.ci-err { color: #f23645; font-size: 13px; min-height: 16px; }
`;

type CustomIndicator = { id: string; name: string; script: string };
type EditorEntry = {
  customId?: string;
  name?: string;
  script?: string;
  handleId?: string;
  originalSource?: string;
};

export function installIndicatorEditor(ws: any) {
  let styleDone = false;
  const ensureStyle = () => {
    if (styleDone) return;
    styleDone = true;
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  };

  const getCustom = async (): Promise<CustomIndicator[]> => {
    const data = await api.get(`${CUSTOM_API}?pageSize=5000`);
    return data?.items ?? [];
  };
  const bundledNames = async (): Promise<Set<string>> => {
    const data = await api.get('/indicators?pageSize=5000');
    return new Set<string>((data?.items ?? []).map((it: any) => it.name));
  };
  const declaredTitle = (s?: string) => {
    const m = /(?:indicator|strategy|library)\s*\(\s*(['"])(.*?)\1/.exec(s || '');
    return m ? m[2] : undefined;
  };
  const applyToChart = async (handleId?: string, source?: string) => {
    if (!handleId || !source) return;
    const chart = ws.cells()[0]?.chart;
    const handle = chart?.indicators().find((h: any) => h.id === handleId);
    if (handle?.updateCode) await handle.updateCode(source).catch(() => {});
  };

  // entry: { customId?, name?, script?, handleId?, originalSource? }
  function open(entry: EditorEntry = {}) {
    ensureStyle();
    const editing = !!(entry.customId || entry.handleId || entry.name);
    const backdrop = document.createElement('div');
    backdrop.className = 'ci-backdrop';
    const dlg = document.createElement('div');
    dlg.className = 'ci-dialog';
    const head = document.createElement('div');
    head.className = 'ci-head';
    const title = document.createElement('div');
    title.className = 'ci-title';
    title.textContent = editing ? '编辑脚本' : '新建脚本';
    const x = document.createElement('button');
    x.className = 'ci-x';
    x.textContent = '✕';
    x.addEventListener('click', () => viewDestroy());
    head.append(title, x);

    const body = document.createElement('div');
    body.className = 'ci-body';
    const name = document.createElement('input');
    name.className = 'ci-name';
    name.placeholder = '指标名称';
    name.value = entry.name ?? '';
    const editorHost = document.createElement('div');
    editorHost.className = 'ci-editor';
    const err = document.createElement('div');
    err.className = 'ci-err';
    body.append(name, editorHost, err);

    const foot = document.createElement('div');
    foot.className = 'ci-foot';
    const cancel = document.createElement('button');
    cancel.className = 'ci-btn';
    cancel.textContent = '取消';
    const save = document.createElement('button');
    save.className = 'ci-btn primary';
    save.textContent = '保存';
    const setBusy = (busy: boolean) => {
      save.disabled = busy;
      save.replaceChildren();
      if (busy) {
        const sp = document.createElement('span');
        sp.className = 'ci-spin';
        save.append(sp, document.createTextNode(' 保存中…'));
      } else {
        save.textContent = '保存';
      }
    };
    cancel.addEventListener('click', () => viewDestroy());
    save.addEventListener('click', async () => {
      const n = name.value.trim();
      const src = view.state.doc.toString();
      if (!n) { err.textContent = '请填写名称'; return; }
      if (!src.trim()) { err.textContent = '脚本不能为空'; return; }
      setBusy(true);
      try {
        const title2 = declaredTitle(entry.originalSource);
        if (entry.customId) {
          await api.post(CUSTOM_API, { id: entry.customId, name: n, script: src });
        } else if (title2 && (await bundledNames()).has(title2)) {
          await api.post(BUNDLED_API, { name: title2, script: src });
        } else {
          await api.post(CUSTOM_API, { name: n, script: src });
        }
        await ws.reloadIndicators?.();
        await applyToChart(entry.handleId, src);
        viewDestroy();
      } catch (error) {
        err.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
        setBusy(false);
      }
    });
    foot.append(cancel, save);
    dlg.append(head, body, foot);
    backdrop.appendChild(dlg);
    document.body.appendChild(backdrop);

    // The editor view — mounted after the host is in the DOM so it measures correctly.
    const view = new EditorView({
      doc: entry.script ?? DEFAULT_SCRIPT,
      parent: editorHost,
      extensions: [
        basicSetup,
        pine,
        oneDark,
        indentUnit.of('    '),
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => { save.click(); return true; } }]),
        EditorView.updateListener.of((u) => { if (u.docChanged) err.textContent = ''; }),
      ],
    });
    function viewDestroy() {
      view.destroy();
      backdrop.remove();
    }
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) viewDestroy(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return; // CodeMirror already consumed it
      // Also skip while a CM overlay is open (search box / autocomplete).
      if (document.querySelector('.cm-search, .cm-tooltip')) return;
      viewDestroy();
      document.removeEventListener('keydown', esc);
    });
    setTimeout(() => (entry.name ? view.focus() : name.focus()), 0);
    return view;
  }

  // ── library events ──
  document.addEventListener('vela-indicator-new', () => open());
  document.addEventListener('vela-indicator-edit', async (event: Event) => {
    const id = (event as CustomEvent).detail?.id;
    const list = await getCustom();
    const entry = list.find((r) => r.id === id);
    if (entry) open({ customId: entry.id, name: entry.name, script: entry.script, originalSource: entry.script });
  });
  document.addEventListener('vela-indicator-delete', async (event: Event) => {
    const { id, name } = (event as CustomEvent).detail || {};
    if (!id) return;
    if (!window.confirm(`删除脚本「${name ?? ''}」？`)) return;
    await api.del(`${CUSTOM_API}?id=${encodeURIComponent(id)}`);
    await ws.reloadIndicators?.();
  });

  // ── legend-row quick edit ──
  registerLegendAction({
    id: 'quick-edit-script',
    icon: 'pen',
    tooltip: '编辑脚本',
    order: -1,
    when: (ind) => ind.source !== undefined,
    async run(ctx, ind) {
      const customs = await getCustom();
      const custom = customs.find((c) => c.script === (ind as any).source);
      open({
        customId: custom?.id,
        name: custom?.name ?? declaredTitle(ind.source) ?? ind.title,
        script: ind.source,
        handleId: ind.id,
        originalSource: ind.source,
      });
    },
  });
}
