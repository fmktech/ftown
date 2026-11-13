import { describe, expect, it } from 'vitest';
import { markdownDocument } from './session-preview-markdown';

describe('markdownDocument', () => {
  it('renders headings, GFM tables, task lists, strikethrough and fenced code', () => {
    const doc = markdownDocument('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~old~~\n\n```js\nconst a = 1;\n```', 'notes.md');
    expect(doc).toContain('<h1>Title</h1>');
    expect(doc).toContain('<div class="md-table-wrap"><table>');
    expect(doc).toContain('<td>1</td>');
    expect(doc).toContain('type="checkbox"');
    expect(doc).toContain('<del>old</del>');
    expect(doc).toContain('<pre><code class="language-js">const a = 1;');
  });

  it('produces a complete document with charset, viewport, title and one style', () => {
    const doc = markdownDocument('hello', 'notes.md');
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('name="viewport"');
    expect(doc).toContain('<title>notes.md</title>');
    expect(doc.match(/<style>/g)).toHaveLength(1);
    expect(doc.endsWith('</body></html>')).toBe(true);
  });

  it('escapes the title', () => {
    expect(markdownDocument('x', '<img onerror=x>')).toContain('<title>&lt;img onerror=x&gt;</title>');
  });

  it('passes raw HTML through and is deterministic with no external resources', () => {
    const source = '<script>alert(1)</script>\n\npara';
    const a = markdownDocument(source, 't.md');
    const b = markdownDocument(source, 't.md');
    expect(a).toBe(b);
    expect(a).toContain('<script>alert(1)</script>');
    expect(a).not.toContain('http://');
    expect(a).not.toContain('https://');
    expect(a).not.toContain('src="http');
  });

  it('keeps line breaks off (no <br>)', () => {
    const doc = markdownDocument('a\nb', 't.md');
    expect(doc).toContain('<p>a\nb</p>');
    expect(doc).not.toContain('<br');
  });
});
