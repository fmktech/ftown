#!/usr/bin/env node
"use strict";
// Dedicated E2E stub. It never invokes gh, shells, or accesses a network.
const fs = require("node:fs");
const args = process.argv.slice(2);
const equal = expected => JSON.stringify(args) === JSON.stringify(expected);
const log = kind => {
  const path = process.env.FTOWN_PR_REVIEW_FAKE_GH_LOG;
  if (path) fs.appendFileSync(path, `${kind}\n`, { encoding: "utf8", mode: 0o600 });
};
const endpoint = "repos/owner/repo/pulls/12";
if (equal(["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", endpoint])) {
  log("metadata");
  process.stdout.write(JSON.stringify({ title: "<img src=x onerror=bad()>", body: "<script>bad()</script>", user: { login: "fixture-author" }, state: "open", merged_at: null, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "topic", sha: "b".repeat(40) }, additions: 1, deletions: 0, changed_files: 1 }));
} else if (equal(["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github.v3.diff", endpoint])) {
  log("diff");
  process.stdout.write("diff --git a/example.txt b/example.txt\nindex 1111111..2222222 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1 @@\n+<svg onload=bad()>\n");
} else if (equal(["api", "graphql", "--hostname", "github.com", "--include", "--input", "-"])) {
  // Unrelated background status polling returns sanitized unavailable. Drain
  // stdin so the real caller receives a clean, finite response.
  process.stdin.resume();
  process.stdin.on("end", () => { log("status"); process.stdout.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 5000, resetAt: "2099-01-01T00:00:00.000Z" } } })); });
} else {
  log("rejected");
  process.stderr.write("Fixture request unavailable\n");
  process.exitCode = 1;
}
