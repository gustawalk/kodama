import { describe, expect, test } from "bun:test";
import { activeVariableReference, variableHasValue, variableSuggestions } from "./variableResolution";

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

  test("offers generators after {rand and resolves either random token spelling", () => {
    const variables = {
      PORT: { value: "3000", source: "Collection", secret: false },
      "$random.uuid": { value: "Generated when sent", source: "Random", secret: false },
    };
    expect(variableSuggestions(activeVariableReference("{{", 2), variables)).toEqual(["PORT"]);
    expect(variableSuggestions(activeVariableReference("{rand", 5), variables)).toEqual(["random.uuid"]);
    expect(variableSuggestions(activeVariableReference("{{rand", 6), variables)).toEqual(["random.uuid"]);
    expect(variableSuggestions(activeVariableReference("{{$rand", 7), variables)).toEqual(["$random.uuid"]);
    expect(variableHasValue("random.uuid", variables)).toBe(true);
    expect(variableHasValue("$random.uuid", variables)).toBe(true);
  });
});
