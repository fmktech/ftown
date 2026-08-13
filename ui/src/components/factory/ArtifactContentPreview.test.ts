import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactContentPreview } from "./ArtifactContentPreview";

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
});
