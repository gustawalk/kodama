import { describe, expect, test } from "bun:test";
import { variableHasValue } from "./variableResolution";

describe("variable readiness", () => {
  test("treats undefined and empty values as unset", () => {
    const variables = {
      PORT: { value: "", source: "Collection", secret: false },
      TOKEN: { value: "  ", source: "Environment", secret: true },
      HOST: { value: "localhost", source: "Collection", secret: false },
    };
    expect(variableHasValue("MISSING", variables)).toBe(false);
    expect(variableHasValue("PORT", variables)).toBe(false);
    expect(variableHasValue("TOKEN", variables)).toBe(false);
    expect(variableHasValue("HOST", variables)).toBe(true);
  });
});
