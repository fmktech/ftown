import { describe, expect, it } from "vitest";
import { parsePullRequestUrl } from "./pull-request-url";

describe("untrusted session PR metadata", () => {
  it.each([
    "https://github.com/Org/repo.name/pull/123",
    " https://github.com/Org/repo.name/pull/000123/?tab=files#review ",
    "HTTPS://GITHUB.COM:443/Org/repo.name/pull/123",
  ])("canonicalizes a GitHub PR destination: %s", value => {
    expect(parsePullRequestUrl(value)).toEqual({ url: "https://github.com/Org/repo.name/pull/123", repository: "Org/repo.name", number: 123 });
  });

  it.each([
    undefined, null, 123, {}, "", " ", "javascript:alert(1)",
    "http://github.com/a/b/pull/1", "https://github.com.evil.test/a/b/pull/1",
    "https://github.com@evil.test/a/b/pull/1", "https://user@github.com/a/b/pull/1",
    "https://github.com:444/a/b/pull/1", "https://github.com/a/b/pull/1/files",
    "https://github.com/a/b/issues/1", "https://github.com/a/b/pull/0",
    "https://github.com/a/b/PULL/1",
    "https://github.com/a/b/pull/-1", "https://github.com/a/b/pull/1.5",
    "https://github.com/a/b/pull/9007199254740992",
    "https://github.com/a/b%2Fc/pull/1", "https://github.com/a/b%00/pull/1",
    "https://github.com/a/b/../b/pull/1", "https://github.com/a/./pull/1",
    "https://github.com/a/../pull/1", "https://github.com/-a/b/pull/1",
    "https://github.com/a-/b/pull/1", "https://github.com/é/b/pull/1",
    "https://github.com/a/b\\pull/1", "https://github.com/a/b/pull/1\n",
    "https://github.com/a/b/pull/1?" + "x".repeat(2048),
  ])("does not produce a link for malformed metadata %#", value => {
    expect(parsePullRequestUrl(value)).toBeNull();
  });

  it("accepts both positive safe integer boundaries", () => {
    expect(parsePullRequestUrl("https://github.com/a/b/pull/1")?.number).toBe(1);
    expect(parsePullRequestUrl("https://github.com/a/b/pull/9007199254740991")?.number).toBe(9007199254740991);
  });

  it("accepts the exact input length limit and discards query content", () => {
    const prefix = "https://github.com/a/b/pull/1?";
    expect(parsePullRequestUrl(prefix + "x".repeat(2048 - prefix.length))?.url).toBe("https://github.com/a/b/pull/1");
    expect(parsePullRequestUrl(prefix + "x".repeat(2049 - prefix.length))).toBeNull();
  });
});
