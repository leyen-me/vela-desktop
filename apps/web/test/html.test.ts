import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/html.ts';

test('escapeHtml neutralizes markup and attribute breakouts', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
  assert.equal(escapeHtml(null), '');
});
