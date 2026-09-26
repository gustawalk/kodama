import { describe, expect, test } from "bun:test";
import { moveSiblingFolder, reorderSiblingFolder } from "./folderOrder";

const folders = [
  { id: "a", name: "A", parentId: null },
  { id: "child", name: "Child", parentId: "a" },
  { id: "b", name: "B", parentId: null },
  { id: "c", name: "C", parentId: null },
];

describe("folder order", () => {
  test("moves a folder among siblings without changing its parent", () => {
    expect(moveSiblingFolder(folders, "c", -1).filter((item) => !item.parentId).map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(reorderSiblingFolder(folders, "a", "c", true).filter((item) => !item.parentId).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(reorderSiblingFolder(folders, "child", "b", false)).toBe(folders);
  });
});
