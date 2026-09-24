import { describe, expect, test } from "bun:test";
import { importOpenApi } from "./openapi";
import { syncCollectionSource } from "./sourceSync";
import { newRequest } from "./types";

const spec = (summary: string, extraQuery = false) => ({
  openapi: "3.0.3", info: { title: "Chat API" }, servers: [{ url: "http://localhost:{{PORT}}" }],
  paths: { "/v1/users/{id}": { get: { summary, parameters: [
    { name: "id", in: "path", schema: { type: "string" } },
    { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
    ...(extraQuery ? [{ name: "sort", in: "query", schema: { type: "string", default: "asc" } }] : []),
  ] } } },
});
const generated = (summary: string, extra = false) => importOpenApi(spec(summary, extra)).collections[0];
const details = { path: "/project/openapi.ts", stamp: "1:123", placeholders: ["PORT"] };

describe("collection source sync", () => {
  test("keeps local edits while updating untouched fields and adding parameters", () => {
    const first = generated("Get user");
    const linked = syncCollectionSource(first, first, details, "merge").collection;
    linked.requests[0].name = "My user request";
    linked.requests[0].query[0].value = "25";
    linked.variables[0].value = "3000";
    const next = generated("Read user", true);
    const { collection, summary } = syncCollectionSource(linked, next, { ...details, stamp: "2:456" }, "merge");
    expect(collection.requests).toHaveLength(1);
    expect(collection.requests[0].name).toBe("My user request");
    expect(collection.requests[0].query.map((row) => [row.key, row.value])).toEqual([["limit", "25"], ["sort", "asc"]]);
    expect(collection.variables[0].value).toBe("3000");
    expect(summary.preserved).toBe(1);
  });

  test("adds operations and retains local routes during merge", () => {
    const first = generated("Get user");
    first.requests.push(newRequest("Manual route"));
    const next = generated("Get user");
    next.requests.push({ ...newRequest("Health"), method: "GET", url: "http://localhost:{{PORT}}/v1/health", sourceKey: "GET /v1/health" });
    const result = syncCollectionSource(first, next, details, "merge");
    expect(result.collection.requests.map((item) => item.name)).toContain("Manual route");
    expect(result.collection.requests.map((item) => item.name)).toContain("Health");
  });

  test("confirmed replace discards collection edits and manual routes", () => {
    const current = generated("Get user");
    current.requests[0].name = "Custom name";
    current.requests.push(newRequest("Manual route"));
    const result = syncCollectionSource(current, generated("From source"), details, "replace");
    expect(result.collection.requests).toHaveLength(1);
    expect(result.collection.requests[0].name).toBe("From source");
    expect(result.collection.id).toBe(current.id);
  });
  test("links an existing imported route with an editable base URL without duplicating it", () => {
    const current = generated("Get user");
    current.requests[0].url = "{{BASE_URL}}/v1/users/:id";
    const result = syncCollectionSource(current, generated("Get user"), details, "merge");
    expect(result.collection.requests).toHaveLength(1);
    expect(result.collection.requests[0].url).toBe("{{BASE_URL}}/v1/users/:id");
    expect(result.collection.requests[0].sourceKey).toBe("GET /v1/users/{id}");
  });

  test("updates untouched source parameters and keeps edited ones if the source removes them", () => {
    const initial = generated("Get user");
    const linked = syncCollectionSource(initial, initial, details, "merge").collection;
    const changed = generated("Get user");
    changed.requests[0].query[0].value = "20";
    const updated = syncCollectionSource(linked, changed, { ...details, stamp: "2" }, "merge").collection;
    expect(updated.requests[0].query[0].value).toBe("20");
    updated.requests[0].query[0].value = "25";
    const removed = generated("Get user");
    removed.requests[0].query = [];
    const final = syncCollectionSource(updated, removed, { ...details, stamp: "3" }, "merge").collection;
    expect(final.requests[0].query.map((row) => [row.key, row.value])).toEqual([["limit", "25"]]);
  });
  test("keeps a locally renamed source folder on later sync", () => {
    const initial = generated("Get user");
    initial.folders.push({ id: "folder-one", name: "Users", parentId: null });
    initial.requests[0].folderId = "folder-one";
    const linked = syncCollectionSource(initial, initial, details, "merge").collection;
    linked.folders[0].name = "My users";
    const incoming = generated("Get user");
    incoming.folders.push({ id: "folder-two", name: "Users", parentId: null });
    incoming.requests[0].folderId = "folder-two";
    const updated = syncCollectionSource(linked, incoming, { ...details, stamp: "2" }, "merge").collection;
    expect(updated.folders.map((folder) => folder.name)).toEqual(["My users"]);
    expect(updated.requests[0].folderId).toBe("folder-one");
  });
});
