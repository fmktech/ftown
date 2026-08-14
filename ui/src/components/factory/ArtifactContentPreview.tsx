"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, useEffect, useId, useState, type ReactNode } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { artifactExtension, imageMimeType } from "./artifact-formats";

function highlightedText(
  source: string,
  query: string,
  keyPrefix = "match",
): ReactNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [source];

  const nodes: ReactNode[] = [];
  const haystack = source.toLocaleLowerCase();
  let cursor = 0;
  let matchNumber = 0;
  while (cursor < source.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    if (index > cursor) nodes.push(source.slice(cursor, index));
    nodes.push(
      <mark
        key={`${keyPrefix}-${matchNumber}`}
        className="rounded-sm bg-amber-300 px-0.5 text-zinc-950"
      >
        {source.slice(index, index + needle.length)}
      </mark>,
    );
    matchNumber += 1;
    cursor = index + needle.length;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

function matchCount(source: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return 0;
  const haystack = source.toLocaleLowerCase();
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function highlightedChildren(
  children: ReactNode,
  query: string,
  keyPrefix: string,
): ReactNode {
  return Children.map(children, (child, index) =>
    typeof child === "string"
      ? highlightedText(child, query, `${keyPrefix}-${index}`)
      : child,
  );
}

function highlightedJson(source: string, query: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const tokenPattern =
    /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index;
    if (index > cursor) {
      tokens.push(...highlightedText(source.slice(cursor, index), query, `gap-${cursor}`));
    }
    const className = match[1]
      ? "text-sky-300"
      : match[2]
        ? "text-emerald-300"
        : match[3]
          ? "text-amber-300"
          : match[4]
            ? "text-purple-300"
            : "text-rose-300";
    tokens.push(
      <span key={index} className={className}>
        {highlightedText(match[0], query, `json-${index}`)}
      </span>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < source.length) {
    tokens.push(...highlightedText(source.slice(cursor), query, `tail-${cursor}`));
  }
  return tokens;
}

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function isolatedHtmlDocument(content: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(content)) {
    return content.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${csp}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(content)) {
    return content.replace(
      /<html(?:\s[^>]*)?>/i,
      (html) => `${html}<head>${csp}</head>`,
    );
  }
  return `<!doctype html><html><head>${csp}</head><body>${content}</body></html>`;
}

export function ArtifactContentPreview({
  relPath,
  content,
}: {
  relPath: string;
  content: string;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [lineFilter, setLineFilter] = useState("");
  const searchInputId = useId();
  const filterInputId = useId();
  const ext = artifactExtension(relPath);
  const searchable =
    imageMimeType(relPath) === undefined && !["html", "htm"].includes(ext);
  const lineFilterable = ["jsonl", "log"].includes(ext);

  useEffect(() => {
    setSearchQuery("");
    setLineFilter("");
  }, [relPath]);

  if (!searchable) {
    return (
      <ArtifactDocumentBody
        relPath={relPath}
        content={content}
        searchQuery=""
        lineFilterable={false}
      />
    );
  }

  const allLines = content.split("\n");
  const filterNeedle = lineFilter.trim().toLocaleLowerCase();
  const visibleContent =
    lineFilterable && filterNeedle !== ""
      ? allLines
          .filter((line) => line.toLocaleLowerCase().includes(filterNeedle))
          .join("\n")
      : content;
  const visibleLineCount =
    lineFilterable && filterNeedle !== ""
      ? visibleContent === ""
        ? 0
        : visibleContent.split("\n").length
      : allLines.length;
  const matches = matchCount(visibleContent, searchQuery);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="search"
        aria-label="Document tools"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/80 px-3 py-2"
      >
        <label htmlFor={searchInputId} className="sr-only">
          Find in document
        </label>
        <input
          id={searchInputId}
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Find in document…"
          className="min-w-40 flex-1 basis-52 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/70"
        />
        <span
          aria-live="polite"
          className="min-w-16 text-right font-mono text-[10px] text-zinc-500"
        >
          {searchQuery.trim() === ""
            ? ""
            : `${matches} ${matches === 1 ? "match" : "matches"}`}
        </span>
        {lineFilterable && (
          <>
            <label htmlFor={filterInputId} className="sr-only">
              Filter lines
            </label>
            <input
              id={filterInputId}
              type="text"
              value={lineFilter}
              onChange={(event) => setLineFilter(event.target.value)}
              placeholder="Filter lines…"
              className="min-w-40 flex-1 basis-52 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/70"
            />
            <span
              aria-live="polite"
              className="min-w-20 text-right font-mono text-[10px] text-zinc-500"
            >
              {filterNeedle === ""
                ? `${allLines.length} lines`
                : `${visibleLineCount} of ${allLines.length} lines`}
            </span>
          </>
        )}
      </div>
      <ArtifactDocumentBody
        relPath={relPath}
        content={visibleContent}
        searchQuery={searchQuery}
        lineFilterable={lineFilterable}
      />
    </div>
  );
}

function ArtifactDocumentBody({
  relPath,
  content,
  searchQuery,
  lineFilterable,
}: {
  relPath: string;
  content: string;
  searchQuery: string;
  lineFilterable: boolean;
}) {
  const ext = artifactExtension(relPath);
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);

  if (["md", "mdx"].includes(ext)) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-5 text-sm leading-6 text-zinc-200">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="mb-4 border-b border-zinc-800 pb-2 text-2xl font-semibold text-zinc-50">
                {highlightedChildren(children, searchQuery, "md-h1")}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-3 mt-6 text-xl font-semibold text-zinc-100">
                {highlightedChildren(children, searchQuery, "md-h2")}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-100">
                {highlightedChildren(children, searchQuery, "md-h3")}
              </h3>
            ),
            strong: ({ children }) => (
              <strong>
                {highlightedChildren(children, searchQuery, "md-strong")}
              </strong>
            ),
            em: ({ children }) => (
              <em>{highlightedChildren(children, searchQuery, "md-em")}</em>
            ),
            li: ({ children }) => (
              <li>{highlightedChildren(children, searchQuery, "md-li")}</li>
            ),
            p: ({ children }) => (
              <p className="my-3">
                {highlightedChildren(children, searchQuery, "md-p")}
              </p>
            ),
            ul: ({ children }) => (
              <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>
            ),
            a: ({ children, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 hover:text-blue-300"
              >
                {highlightedChildren(children, searchQuery, "md-a")}
              </a>
            ),
            img: ({ src, alt }) => {
              const safeSource =
                typeof src === "string" &&
                /^(?:data:image\/|blob:)/i.test(src);
              if (!safeSource) {
                return (
                  <span
                    role="img"
                    aria-label={alt ?? "remote image"}
                    className="inline-flex rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-500"
                  >
                    Remote image blocked: {alt || "untitled image"}
                  </span>
                );
              }
              return (
                // eslint-disable-next-line @next/next/no-img-element -- trusted local data/blob Markdown asset
                <img
                  src={src}
                  alt={alt ?? ""}
                  className="my-4 max-w-full rounded border border-zinc-800"
                />
              );
            },
            blockquote: ({ children }) => (
              <blockquote className="my-3 border-l-2 border-zinc-600 pl-4 text-zinc-400">
                {highlightedChildren(children, searchQuery, "md-quote")}
              </blockquote>
            ),
            code: ({ children }) => (
              <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[0.9em] text-amber-200">
                {highlightedChildren(children, searchQuery, "md-code")}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="my-4 overflow-auto rounded border border-zinc-800 bg-black/40 p-3 font-mono text-xs leading-5 text-zinc-200">
                {children}
              </pre>
            ),
            table: ({ children }) => (
              <div className="my-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  {children}
                </table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-semibold">
                {highlightedChildren(children, searchQuery, "md-th")}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-zinc-800 px-2 py-1.5">
                {highlightedChildren(children, searchQuery, "md-td")}
              </td>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  if (["html", "htm"].includes(ext)) {
    return (
      <iframe
        title={`HTML preview: ${name}`}
        sandbox=""
        srcDoc={isolatedHtmlDocument(content)}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    );
  }

  if (ext === "json") {
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      return (
        <pre
          aria-label="Formatted JSON preview"
          className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5 text-zinc-300 sm:text-sm"
        >
          {highlightedJson(formatted, searchQuery)}
        </pre>
      );
    } catch {
      // Invalid/in-progress JSON remains readable through the text fallback.
    }
  }

  if (["yaml", "yml"].includes(ext)) {
    try {
      const formatted = stringifyYaml(parseYaml(content));
      return (
        <pre
          aria-label="Formatted YAML preview"
          className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5 text-zinc-300 sm:text-sm"
        >
          {highlightedText(formatted, searchQuery, "yaml")}
        </pre>
      );
    } catch {
      // Invalid/in-progress YAML remains readable through the text fallback.
    }
  }

  const mimeType = imageMimeType(relPath);
  if (mimeType !== undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[linear-gradient(45deg,#18181b_25%,transparent_25%),linear-gradient(-45deg,#18181b_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#18181b_75%),linear-gradient(-45deg,transparent_75%,#18181b_75%)] bg-[length:24px_24px] p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- local base64 artifact has no URL loader */}
        <img
          src={`data:${mimeType};base64,${content.trim()}`}
          alt={name}
          className="max-h-full max-w-full object-contain shadow-2xl"
        />
      </div>
    );
  }

  return (
    <pre
      aria-label={lineFilterable ? "Filtered line preview" : undefined}
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-zinc-200 sm:text-sm"
    >
      {content === ""
        ? "(empty file)"
        : highlightedText(content, searchQuery, "text")}
    </pre>
  );
}
