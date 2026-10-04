import { describe, expect, test } from "bun:test";
import { readTabSessions, restoreTabSession } from "./tabSession";

describe("request tab restoration", () => {
  test("restores ordinary and pinned tabs in order with the active tab", () => {
    expect(
      restoreTabSession(
        { tabs: ["pin", "ordinary"], selectedId: "ordinary" },
        ["pin"],
        new Set(["pin", "ordinary"]),
        "pin",
      ),
    ).toEqual({ tabs: ["pin", "ordinary"], selectedId: "ordinary" });
  });

  test("removes deleted requests and keeps valid pins open", () => {
    expect(
      restoreTabSession(
        { tabs: ["deleted", "ordinary"], selectedId: "deleted" },
        ["pin"],
        new Set(["pin", "ordinary"]),
        "ordinary",
      ),
    ).toEqual({ tabs: ["ordinary", "pin"], selectedId: "ordinary" });
  });

  test("preserves an intentionally empty tab bar", () => {
    expect(
      restoreTabSession({ tabs: [], selectedId: null }, [], new Set(["request"]), "request"),
    ).toEqual({ tabs: [], selectedId: null });
  });

  test("restores legacy pins and ignores invalid saved data", () => {
    expect(readTabSessions('{"workspace":{"tabs":[2],"selectedId":null}}')).toEqual({});
    expect(readTabSessions("invalid")).toEqual({});
    expect(restoreTabSession(undefined, ["pin"], new Set(["pin"]), "pin")).toEqual({
      tabs: ["pin"],
      selectedId: "pin",
    });
  });
});
