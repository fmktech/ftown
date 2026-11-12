import { Marked } from 'marked';

/** GFM on (tables, task lists, strikethrough, fenced code); no highlight lib. */
const marked = new Marked({ gfm: true, breaks: false });

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Horizontally scrollable wrapper around markdown tables. */
function wrapTables(html: string): string {
  return html
    .replace(/<table(\s[^<>]*?)?>/g, '<div class="md-table-wrap"><table$1>')
    .replace(/<\/table>/g, '</table></div>');
}

const MARKDOWN_STYLE = String.raw`
:root { color-scheme: light dark; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  line-height: 1.6;
  max-width: 78ch;
  margin: 0 auto;
  padding: 1rem 16px;
  box-sizing: border-box;
  background: #ffffff;
  color: #1a1a1a;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; }
h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
a { color: #0b5cad; }
ul, ol { padding-left: 1.5em; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #cccccc; }
.md-table-wrap { overflow-x: auto; }
table { border-collapse: collapse; }
th, td { border: 1px solid #cccccc; padding: 0.4em 0.8em; }
pre { overflow-x: auto; padding: 1em; border-radius: 6px; background: #f4f4f4; }
pre code { white-space: pre; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
hr { border: 0; border-top: 1px solid #cccccc; }
img { max-width: 100%; height: auto; }
@media (prefers-color-scheme: dark) {
  body { background: #1e1e1e; color: #e8e8e8; }
  a { color: #7db3f0; }
  blockquote { border-left-color: #555555; }
  th, td { border-color: #555555; }
  pre { background: #2a2a2a; }
  hr { border-top-color: #555555; }
}
`;

/**
 * Render markdown source as a complete standalone HTML document.
 * Raw HTML passes through unchanged (marked default); isolation comes from
 * the sandboxed iframe + CSP applied by previewDocument, not from sanitizing.
 */
export function markdownDocument(source: string, title: string): string {
  const body = marked.parse(source, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${MARKDOWN_STYLE}</style></head><body>${wrapTables(body)}</body></html>`;
}
