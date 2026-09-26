import { describe, expect, test } from "bun:test";
import { bundleOpenApiRefs } from "./openapiRefs";
import { importOpenApi } from "./openapi";

describe("local OpenAPI references", () => {
  test("loads nested YAML references and reports their stamps for sync", async () => {
    const root = { path: "/project/api.json", stamp: "root", contents: "" };
    const document = { openapi: "3.0.3", info: { title: "Linked" }, paths: { "/items/{id}": { post: { parameters: [{ $ref: "./parts/params.yaml#/Id" }], requestBody: { $ref: "./parts/body.json#/Body" } } } } };
    const files = new Map([
      ["/project/parts/params.yaml", { path: "/project/parts/params.yaml", stamp: "params", contents: "Id:\n  name: id\n  in: path\n  example: item-1\n" }],
      ["/project/parts/body.json", { path: "/project/parts/body.json", stamp: "body", contents: JSON.stringify({ Body: { content: { "application/json": { schema: { type: "object", properties: { id: { $ref: "./params.yaml#/schema" } } } } } } }) }],
    ]);
    // Keep this nested reference valid so it tests both traversal and YAML parsing.
    files.get("/project/parts/params.yaml")!.contents += "schema:\n  type: string\n  example: nested\n";
    const bundled = await bundleOpenApiRefs(root, document, async (path) => { const file = files.get(path); if (!file) throw new Error(`Missing: ${path}`); return file; });
    expect(bundled.dependencies.map((item) => item.stamp)).toEqual(["params", "body"]);
    const request = importOpenApi(bundled.document).collections[0].requests[0];
    expect(request.pathParams[0].value).toBe("item-1");
  });
  test("reports missing references", () => {
    expect(() => importOpenApi({ openapi: "3.0.3", info: { title: "X" }, paths: { "/x": { $ref: "#/missing" } } })).toThrow("Missing OpenAPI reference");
  });
  test("rejects references outside the selected source directory", async () => {
    const root = { path: "/project/api.json", stamp: "root", contents: "" };
    const result = await bundleOpenApiRefs(root, { openapi: "3.0.3", paths: { "/x": { $ref: "../private.json#/x" } } }, async () => { throw new Error("File should not be read"); });
    expect(result.warnings[0].message).toContain("leaves the selected source directory");
    expect((result.document as { paths: object }).paths).toEqual({});
  });
  test("keeps valid routes when another external path is malformed", async () => {
    const root = { path: "/project/api.json", stamp: "root", contents: "" };
    const document = { openapi: "3.0.3", paths: { "/good": { get: { summary: "Good" } }, "/bad": { $ref: "./bad.json" } } };
    const bundled = await bundleOpenApiRefs(root, document, async (path) => ({ path, stamp: "bad", contents: "{" }));
    const store = importOpenApi(bundled.document);
    expect(store.collections[0].requests.map((item) => item.name)).toEqual(["Good"]);
    expect(bundled.warnings[0].path).toBe("/bad");
    expect(bundled.dependencies).toEqual([{ path: "/project/bad.json", stamp: "bad" }]);
  });
  test("resolves fragment references back to the root and retains routes with missing nested files", async () => {
    const root = { path: "/project/api.json", stamp: "root", contents: "" };
    const document = {
      openapi: "3.0.3", info: { title: "Linked" },
      components: { schemas: { Item: { type: "object", properties: { name: { type: "string", example: "Lamp" } } } } },
      paths: { "/items": { post: { parameters: [{ $ref: "./missing-header.json" }], requestBody: { content: { "application/json": { schema: { $ref: "./dto.json#/CreateItem" } } } } } } },
    };
    const bundled = await bundleOpenApiRefs(root, document, async (path) => {
      if (path === "/project/dto.json") return { path, stamp: "dto", contents: JSON.stringify({ CreateItem: { $ref: "#/components/schemas/Item" } }) };
      throw new Error(`Missing: ${path}`);
    });
    const request = importOpenApi(bundled.document).collections[0].requests[0];
    expect(JSON.parse(request.body.text)).toEqual({ name: "Lamp" });
    expect(bundled.warnings).toEqual([{ path: "POST /items", message: "Missing OpenAPI reference file: /project/missing-header.json" }]);
    expect(bundled.dependencies).toContainEqual({ path: "/project/missing-header.json", stamp: "missing" });
  });
});
