// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactContentPreview } from "./ArtifactContentPreview";

afterEach(cleanup);

describe("ArtifactContentPreview", () => {
  it("renders a self-contained HTML artifact in a sandboxed document", () => {
    const document =
      "<!doctype html><html><head><style>h1{color:tomato}</style></head><body><h1>RCA report</h1></body></html>";
    const html = renderToStaticMarkup(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/report.html",
        content: document,
      }),
    );

    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox=""');
    expect(html).toContain('title="HTML preview: report.html"');
    expect(html).toContain("default-src");
    expect(html).toContain("connect-src");
    expect(html).toContain("RCA report");
  });

  it("pretty-prints JSON instead of showing a minified blob", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/evidence.json",
        content: '{"status":"ok","items":[1,2],"active":true}',
      }),
    );

    expect(html).toContain('aria-label="Formatted JSON preview"');
    expect(html).toContain("{\n  ");
    expect(html).toContain("&quot;status&quot;");
    expect(html).toContain("&quot;ok&quot;");
    expect(html).toContain("true");
  });

  it("formats YAML into a readable structured document", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/evidence.yaml",
        content: "service: {name: ftown, ports: [3000, 8000]}",
      }),
    );

    expect(html).toContain('aria-label="Formatted YAML preview"');
    expect(html).toContain("service:\n  name: ftown\n  ports:\n    - 3000\n    - 8000");
  });

  it("renders an image artifact from its base64 bridge payload", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/evidence/screenshot.png",
        content: "iVBORw0KGgoAAAANSUhEUg==",
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain(
      'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="',
    );
    expect(html).toContain('alt="screenshot.png"');
  });

  it("does not fetch remote images embedded in Markdown", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/request.md",
        content: "![tracking pixel](https://attacker.example/pixel.png)",
      }),
    );

    expect(html).not.toContain("attacker.example");
    expect(html).toContain("Remote image blocked: tracking pixel");
  });

  it("finds and highlights matches inside a text document", () => {
    render(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/notes.txt",
        content: "Alpha finding\nbeta\nalpha follow-up",
      }),
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find in document" }),
      { target: { value: "alpha" } },
    );

    expect(screen.getByText("2 matches")).toBeTruthy();
    expect(document.querySelectorAll("mark")).toHaveLength(2);
  });

  it("highlights search matches inside rendered Markdown formatting", () => {
    render(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/rca.md",
        content: "# Root cause\n\n**Finding** documented",
      }),
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find in document" }),
      { target: { value: "finding" } },
    );

    expect(screen.getByText("1 match")).toBeTruthy();
    expect(document.querySelector("strong mark")?.textContent).toBe("Finding");
  });

  it("filters log lines without losing the total line count", () => {
    render(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/logs/worker.log",
        content: "INFO bridge ready\nERROR request failed\nERROR retry failed",
      }),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Filter lines" }), {
      target: { value: "error" },
    });

    expect(screen.getByText("2 of 3 lines")).toBeTruthy();
    const preview = screen.getByLabelText("Filtered line preview");
    expect(preview.textContent).toBe(
      "ERROR request failed\nERROR retry failed",
    );
  });

  it("filters JSONL records one line at a time", () => {
    render(
      createElement(ArtifactContentPreview, {
        relPath: ".ffactory/tickets/42/events.jsonl",
        content:
          '{"level":"info","message":"ready"}\n{"level":"error","message":"failed"}',
      }),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Filter lines" }), {
      target: { value: '"level":"error"' },
    });

    expect(screen.getByLabelText("Filtered line preview").textContent).toBe(
      '{"level":"error","message":"failed"}',
    );
  });
});
