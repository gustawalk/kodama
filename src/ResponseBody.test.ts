import { expect, test } from "bun:test";
import { findResponseMatches } from "./ResponseBody";

test("finds and navigates matches in a response with more than 100,000 lines", () => {
  const body = Array.from({ length: 100_001 }, (_, index) => `line ${index}: value`).join("\n");
  const matches = findResponseMatches(body, "LINE 100000");
  expect(matches).toHaveLength(1);
  expect(body.slice(matches[0], matches[0] + 11)).toBe("line 100000");
  expect(findResponseMatches(body, "missing")).toEqual([]);
});
