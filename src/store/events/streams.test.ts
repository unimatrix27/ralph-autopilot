import { describe, expect, it } from "vitest";
import {
  isSystemStream,
  issueStreamId,
  parseIssueStreamId,
  SYSTEM_STREAM_ID,
} from "./streams";

describe("issue stream identity", () => {
  it("builds <repo>#<issue> (aligned with UNIQUE(repo, issue_number))", () => {
    expect(issueStreamId("acme/example-monorepo", 77)).toBe(
      "acme/example-monorepo#77",
    );
  });

  it("round-trips a repo slug containing a slash", () => {
    const id = issueStreamId("owner/name", 101);
    expect(parseIssueStreamId(id)).toEqual({ repo: "owner/name", issueNumber: 101 });
  });

  it("splits on the last # so a repo could (defensively) contain one", () => {
    expect(parseIssueStreamId("weird#repo#5")).toEqual({ repo: "weird#repo", issueNumber: 5 });
  });

  it("rejects malformed ids and the system stream", () => {
    expect(parseIssueStreamId(SYSTEM_STREAM_ID)).toBeNull();
    expect(parseIssueStreamId("no-hash")).toBeNull();
    expect(parseIssueStreamId("repo#")).toBeNull();
    expect(parseIssueStreamId("repo#notanumber")).toBeNull();
    expect(parseIssueStreamId("#5")).toBeNull();
  });
});

describe("system stream identity", () => {
  it("is $-prefixed and disjoint from every issue stream", () => {
    expect(isSystemStream(SYSTEM_STREAM_ID)).toBe(true);
    expect(isSystemStream("owner/name#1")).toBe(false);
    // a repo slug never starts with $, so the namespaces cannot collide
    expect(parseIssueStreamId(SYSTEM_STREAM_ID)).toBeNull();
  });
});
