import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/pr-diff";
import { PR_DIFF_MAX_LINES } from "@/lib/pr-diff-types";
import type { DiffFile, ParsedDiff } from "@/lib/pr-diff-types";

const join = (...lines: string[]) => lines.join("\n") + "\n";

function parse(diff: string): ParsedDiff {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed) throw new Error("expected diff to parse");
  return parsed;
}

function firstFile(diff: string): DiffFile {
  const file = parse(diff).files[0];
  if (!file) throw new Error("expected a file");
  return file;
}

describe("parseUnifiedDiff", () => {
  it("returns an empty diff for empty and whitespace-only input", () => {
    const empty = { files: [], additions: 0, deletions: 0, lineCount: 0 };
    expect(parseUnifiedDiff("")).toEqual(empty);
    expect(parseUnifiedDiff("  \n\t\n \n")).toEqual(empty);
  });

  it("parses a simple modification with two hunks", () => {
    const diff = join(
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@ function one()",
      " keep",
      "-old",
      "+new",
      " tail",
      "@@ -10,2 +10,3 @@",
      " ctx",
      "+added",
      " end",
    );
    expect(parse(diff)).toEqual({
      files: [
        {
          index: 0,
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
          path: "src/a.ts",
          status: "modified",
          binary: false,
          modeChange: null,
          similarity: null,
          additions: 2,
          deletions: 1,
          hunks: [
            {
              header: "@@ -1,3 +1,3 @@ function one()",
              section: "function one()",
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 3,
              lines: [
                { kind: "context", text: "keep", oldNumber: 1, newNumber: 1, noNewlineAtEnd: false },
                { kind: "delete", text: "old", oldNumber: 2, newNumber: null, noNewlineAtEnd: false },
                { kind: "add", text: "new", oldNumber: null, newNumber: 2, noNewlineAtEnd: false },
                { kind: "context", text: "tail", oldNumber: 3, newNumber: 3, noNewlineAtEnd: false },
              ],
            },
            {
              header: "@@ -10,2 +10,3 @@",
              section: "",
              oldStart: 10,
              oldLines: 2,
              newStart: 10,
              newLines: 3,
              lines: [
                { kind: "context", text: "ctx", oldNumber: 10, newNumber: 10, noNewlineAtEnd: false },
                { kind: "add", text: "added", oldNumber: null, newNumber: 11, noNewlineAtEnd: false },
                { kind: "context", text: "end", oldNumber: 11, newNumber: 12, noNewlineAtEnd: false },
              ],
            },
          ],
        },
      ],
      additions: 2,
      deletions: 1,
      lineCount: 7,
    });
  });

  it("parses an added file", () => {
    const file = firstFile(
      join(
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ),
    );
    expect(file.status).toBe("added");
    expect(file.oldPath).toBeNull();
    expect(file.newPath).toBe("new.txt");
    expect(file.path).toBe("new.txt");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks[0]?.lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ["add", "one", null, 1],
      ["add", "two", null, 2],
    ]);
  });

  it("parses a deleted file", () => {
    const file = firstFile(
      join(
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
      ),
    );
    expect(file.status).toBe("deleted");
    expect(file.oldPath).toBe("gone.txt");
    expect(file.newPath).toBeNull();
    expect(file.path).toBe("gone.txt");
    expect(file.deletions).toBe(2);
    expect(file.hunks[0]?.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ["delete", 1, null],
      ["delete", 2, null],
    ]);
  });

  it("parses a 100% rename without hunks", () => {
    const file = firstFile(
      join(
        "diff --git a/old/name.ts b/new/name.ts",
        "similarity index 100%",
        "rename from old/name.ts",
        "rename to new/name.ts",
      ),
    );
    expect(file).toEqual({
      index: 0,
      oldPath: "old/name.ts",
      newPath: "new/name.ts",
      path: "new/name.ts",
      status: "renamed",
      binary: false,
      modeChange: null,
      similarity: 100,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it("parses a rename with changes where names contain spaces", () => {
    const file = firstFile(
      join(
        "diff --git a/my file.txt b/your file.txt",
        "similarity index 90%",
        "rename from my file.txt",
        "rename to your file.txt",
        "index 1111111..2222222 100644",
        "--- a/my file.txt",
        "+++ b/your file.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("my file.txt");
    expect(file.newPath).toBe("your file.txt");
    expect(file.path).toBe("your file.txt");
    expect(file.similarity).toBe(90);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it("handles a modified path with spaces via the unambiguous header and ---/+++", () => {
    const withBody = (header: string) =>
      join(header, "--- a/my dir/my file.txt", "+++ b/my dir/my file.txt", "@@ -1 +1 @@", "-a", "+b");
    const file = firstFile(withBody("diff --git a/my dir/my file.txt b/my dir/my file.txt"));
    expect(file.oldPath).toBe("my dir/my file.txt");
    expect(file.newPath).toBe("my dir/my file.txt");
    expect(file.status).toBe("modified");
    // Ambiguous header: paths come from ---/+++ instead.
    const ambiguous = firstFile(withBody("diff --git a/my dir/my file.txt b/other b/my dir/my file.txt"));
    expect(ambiguous.path).toBe("my dir/my file.txt");
  });

  it("drops a trailing tab and anything after it from ---/+++ paths", () => {
    const file = firstFile(
      join("diff --git a/x b/x", "--- a/x\t2020-01-01", "+++ b/x\t2020-01-02", "@@ -1 +1 @@", "-a", "+b"),
    );
    expect(file.oldPath).toBe("x");
    expect(file.newPath).toBe("x");
  });

  it("decodes quoted octal UTF-8 paths", () => {
    const file = firstFile(
      join(
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        'index 1111111..2222222 100644',
        '--- "a/caf\\303\\251.txt"',
        '+++ "b/caf\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
    expect(file.oldPath).toBe("café.txt");
    expect(file.newPath).toBe("café.txt");
    expect(file.path).toBe("café.txt");
  });

  it("returns null for malformed quoting in a path", () => {
    const diff = join('diff --git a/x b/x', '--- "a/unterminated', "+++ b/x", "@@ -1 +1 @@", "-a", "+b");
    expect(parseUnifiedDiff(diff)).toBeNull();
  });

  it("parses binary files that differ (modified and new)", () => {
    const parsed = parse(
      join(
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/fresh.png b/fresh.png",
        "new file mode 100644",
        "index 0000000..3333333",
        "Binary files /dev/null and b/fresh.png differ",
      ),
    );
    const [modified, added] = parsed.files;
    expect(modified?.binary).toBe(true);
    expect(modified?.status).toBe("modified");
    expect(modified?.hunks).toEqual([]);
    expect(modified?.path).toBe("img.png");
    expect(added?.binary).toBe(true);
    expect(added?.status).toBe("added");
    expect(added?.oldPath).toBeNull();
    expect(added?.path).toBe("fresh.png");
    expect(parsed.lineCount).toBe(0);
  });

  it("skips a GIT binary patch block and parses the next file", () => {
    const parsed = parse(
      join(
        "diff --git a/blob.bin b/blob.bin",
        "new file mode 100644",
        "index 0000000..1234567",
        "GIT binary patch",
        "literal 10",
        "zcmV-q0Ls=Q",
        "",
        "literal 0",
        "HcmV?d00001",
        "",
        "diff --git a/next.txt b/next.txt",
        "--- a/next.txt",
        "+++ b/next.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]?.binary).toBe(true);
    expect(parsed.files[0]?.hunks).toEqual([]);
    expect(parsed.files[1]?.path).toBe("next.txt");
    expect(parsed.files[1]?.index).toBe(1);
    expect(parsed.files[1]?.additions).toBe(1);
  });

  it("parses a mode-only change", () => {
    const file = firstFile(
      join("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"),
    );
    expect(file.modeChange).toEqual({ oldMode: "100644", newMode: "100755" });
    expect(file.status).toBe("modified");
    expect(file.hunks).toEqual([]);
    expect(file.path).toBe("run.sh");
  });

  it("marks noNewlineAtEnd on delete and add lines", () => {
    const file = firstFile(
      join(
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ),
    );
    const lines = file.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "delete", text: "old", noNewlineAtEnd: true });
    expect(lines[1]).toMatchObject({ kind: "add", text: "new", noNewlineAtEnd: true });
  });

  it("marks noNewlineAtEnd on an add line when only the new side lacks a newline", () => {
    const file = firstFile(
      join(
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ -1 +1,2 @@",
        " same",
        "+tail",
        "\\ No newline at end of file",
      ),
    );
    const lines = file.hunks[0]?.lines ?? [];
    expect(lines[0]?.noNewlineAtEnd).toBe(false);
    expect(lines[1]).toMatchObject({ kind: "add", text: "tail", noNewlineAtEnd: true });
  });

  it("treats an empty line inside a hunk as context with empty text", () => {
    const file = firstFile(
      join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "", " c"),
    );
    const lines = file.hunks[0]?.lines ?? [];
    expect(lines[1]).toEqual({ kind: "context", text: "", oldNumber: 2, newNumber: 2, noNewlineAtEnd: false });
    expect(lines[2]?.oldNumber).toBe(3);
  });

  it("keeps trailing carriage returns on CRLF content", () => {
    const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\r\n+new\r\n";
    const lines = firstFile(diff).hunks[0]?.lines ?? [];
    expect(lines[0]?.text).toBe("old\r");
    expect(lines[1]?.text).toBe("new\r");
  });

  it("preserves whitespace in content verbatim", () => {
    const diff = join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-  \told  ", "+  \tnew  ");
    const lines = firstFile(diff).hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.text)).toEqual(["  \told  ", "  \tnew  "]);
  });

  it("skips blank lines before the first header but rejects other preamble", () => {
    const body = join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b");
    expect(parseUnifiedDiff("\n  \n" + body)?.files).toHaveLength(1);
    expect(parseUnifiedDiff("hello world\n" + body)).toBeNull();
  });

  it("returns null for a malformed hunk header", () => {
    expect(parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -x +1 @@", "-a"))).toBeNull();
    expect(parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1", "-a", "+b"))).toBeNull();
  });

  it("returns null for a truncated hunk", () => {
    expect(
      parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "-b")),
    ).toBeNull();
  });

  it("returns null for an unexpected line inside a hunk", () => {
    expect(
      parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " a", "?bogus")),
    ).toBeNull();
  });

  it("returns null when an add line exceeds the remaining new count", () => {
    expect(
      parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1 @@", " a", "-b", "+c", "+d")),
    ).toBeNull();
  });

  it("returns null for an unexpected line after a hunk", () => {
    expect(
      parseUnifiedDiff(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b", "garbage")),
    ).toBeNull();
  });

  it("tolerates blank lines at the very end of input", () => {
    const diff = join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b") + "\n\n";
    expect(parseUnifiedDiff(diff)?.files).toHaveLength(1);
  });

  it("treats header-looking content lines inside counts as content", () => {
    const file = firstFile(
      join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "--- x", "+++ y"),
    );
    const lines = file.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["delete", "-- x"],
      ["add", "++ y"],
    ]);
  });

  it("treats a diff --git line inside hunk counts as content", () => {
    const file = firstFile(
      join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-diff --git a/z b/z", "+diff --git a/y b/y"),
    );
    expect(file.hunks[0]?.lines.map((l) => l.text)).toEqual(["diff --git a/z b/z", "diff --git a/y b/y"]);
  });

  it("defaults omitted hunk counts to 1", () => {
    const hunk = firstFile(join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3 +3 @@", "-a", "+b")).hunks[0];
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(hunk?.lines.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [3, null],
      [null, 3],
    ]);
  });

  it("keeps hostile content verbatim", () => {
    const hostile = "<svg onload=bad()>";
    const file = firstFile(
      join("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", `-${hostile}`, `+<img src=x onerror=bad()>`),
    );
    expect(file.hunks[0]?.lines[0]?.text).toBe(hostile);
    expect(file.hunks[0]?.lines[1]?.text).toBe("<img src=x onerror=bad()>");
  });

  it("returns null above PR_DIFF_MAX_LINES", () => {
    const diff = "x\n".repeat(PR_DIFF_MAX_LINES + 1);
    expect(parseUnifiedDiff(diff)).toBeNull();
  });

  it("never throws on pseudo-random input", () => {
    const fragments = [
      "diff --git a/x b/x",
      "@@ -1,2 +1,2 @@",
      "+",
      "-",
      " ",
      "\\ No newline at end of file",
      "--- a/x",
      "+++ b/x",
      "\n",
      "@@",
      "rename from y",
      "",
    ];
    let seed = 123456789;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      const count = next() % 20;
      const parts: string[] = [];
      for (let j = 0; j < count; j++) parts.push(fragments[next() % fragments.length] ?? "");
      const input = parts.join(next() % 2 === 0 ? "\n" : "");
      let result: ParsedDiff | null | undefined;
      expect(() => {
        result = parseUnifiedDiff(input);
      }).not.toThrow();
      expect(result === null || typeof result === "object").toBe(true);
    }
  });

  it("parses many large files quickly with sequential indexes", () => {
    const lines: string[] = [];
    for (let f = 0; f < 50; f++) {
      lines.push(`diff --git a/dir/file${f}.ts b/dir/file${f}.ts`, `--- a/dir/file${f}.ts`, `+++ b/dir/file${f}.ts`);
      lines.push("@@ -1,200 +1,200 @@");
      for (let i = 0; i < 200; i++) lines.push(`-old line ${i}`);
      for (let i = 0; i < 200; i++) lines.push(`+new line ${i}`);
    }
    const start = performance.now();
    const parsed = parse(join(...lines));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(parsed.files).toHaveLength(50);
    expect(parsed.lineCount).toBe(50 * 400);
    expect(parsed.additions).toBe(50 * 200);
    expect(parsed.deletions).toBe(50 * 200);
    parsed.files.forEach((file, i) => {
      expect(file.index).toBe(i);
      expect(file.path).toBe(file.newPath ?? file.oldPath);
    });
  });

  it("sums per-file counts into totals and keeps path = newPath ?? oldPath", () => {
    const parsed = parse(
      join(
        "diff --git a/a b/a",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1,2 @@",
        " k",
        "+n",
        "diff --git a/b b/b",
        "deleted file mode 100644",
        "--- a/b",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-z",
      ),
    );
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(parsed.lineCount).toBe(3);
    expect(parsed.files.map((f) => f.index)).toEqual([0, 1]);
    for (const f of parsed.files) expect(f.path).toBe(f.newPath ?? f.oldPath);
    expect(parsed.files[1]?.path).toBe("b");
  });
});
