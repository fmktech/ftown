"use client";

import { memo, useMemo } from "react";
import { emphasisByLine, toSplitRows } from "@/lib/pr-diff-split";
import type { DiffHunk, DiffLine, EmphasisRange, SplitRow } from "@/lib/pr-diff-types";
import { REVIEW_GLYPHS, REVIEW_LABELS, type DiffTableProps } from "@/lib/pr-review-types";

type EmphasisMap = ReadonlyMap<DiffLine, EmphasisRange>;

function CodeText({ line, emphasis }: { line: DiffLine; emphasis: EmphasisMap }) {
  const range = emphasis.get(line);
  return (
    <>
      <span className="pr-review-text">
        {range ? (
          <>
            {line.text.slice(0, range[0])}
            <mark className="pr-review-emph">{line.text.slice(range[0], range[1])}</mark>
            {line.text.slice(range[1])}
          </>
        ) : (
          line.text
        )}
      </span>
      {line.noNewlineAtEnd ? (
        <span className="pr-review-eof" title={REVIEW_LABELS.eof} aria-label={REVIEW_LABELS.eof}>
          {REVIEW_GLYPHS.eof}
        </span>
      ) : null}
    </>
  );
}

const KIND_CLASS = { add: "is-add", delete: "is-del", context: "is-ctx" } as const;
const SIGN = { add: "+", delete: "-", context: " " } as const;

function UnifiedHunk({ hunk, hunkIndex }: { hunk: DiffHunk; hunkIndex: number }) {
  const emphasis = useMemo(() => emphasisByLine(hunk), [hunk]);
  return (
    <>
      <tr className="pr-review-hunk">
        <td colSpan={3}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, i) => (
        <tr key={`h${hunkIndex}-${i}`} className={`pr-review-line ${KIND_CLASS[line.kind]}`}>
          <td className="pr-review-num">{line.oldNumber ?? ""}</td>
          <td className="pr-review-num">{line.newNumber ?? ""}</td>
          <td className="pr-review-code">
            <span className="pr-review-sign">{SIGN[line.kind]}</span>
            <CodeText line={line} emphasis={emphasis} />
          </td>
        </tr>
      ))}
    </>
  );
}

function sideClass(line: DiffLine | null, side: "left" | "right"): string {
  if (!line) return "is-empty";
  if (line.kind === "context") return "is-ctx";
  return side === "left" ? "is-del" : "is-add";
}

function SplitHunk({ hunk, hunkIndex }: { hunk: DiffHunk; hunkIndex: number }) {
  const emphasis = useMemo(() => emphasisByLine(hunk), [hunk]);
  const rows: SplitRow[] = useMemo(() => toSplitRows(hunk), [hunk]);
  return (
    <>
      <tr className="pr-review-hunk">
        <td colSpan={4}>{hunk.header}</td>
      </tr>
      {rows.map((row, i) => {
        const l = sideClass(row.left, "left");
        const r = sideClass(row.right, "right");
        return (
          <tr key={`h${hunkIndex}-${i}`} className="pr-review-line is-split">
            <td className={`pr-review-num ${l}`}>{row.left?.oldNumber ?? ""}</td>
            <td className={`pr-review-code ${l}`}>
              {row.left ? <CodeText line={row.left} emphasis={emphasis} /> : null}
            </td>
            <td className={`pr-review-num ${r}`}>{row.right?.newNumber ?? ""}</td>
            <td className={`pr-review-code ${r}`}>
              {row.right ? <CodeText line={row.right} emphasis={emphasis} /> : null}
            </td>
          </tr>
        );
      })}
    </>
  );
}

export const DiffTable = memo(function DiffTable({ hunks, layout, label }: DiffTableProps) {
  const split = layout === "split";
  return (
    <table className={`pr-review-diff ${split ? "is-split" : "is-unified"}`} aria-label={`Diff for ${label}`}>
      <tbody>
        {hunks.map((hunk, hi) =>
          split ? (
            <SplitHunk key={`h${hi}`} hunk={hunk} hunkIndex={hi} />
          ) : (
            <UnifiedHunk key={`h${hi}`} hunk={hunk} hunkIndex={hi} />
          ),
        )}
      </tbody>
    </table>
  );
});
