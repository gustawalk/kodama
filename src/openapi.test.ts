import { describe, expect, test } from "bun:test";
import { importOpenApi } from "./openapi";

describe("OpenAPI import", () => {
  test("imports OpenAPI 3 paths, parameters, tags, and JSON examples", () => {
    const store = importOpenApi({
      openapi: "3.0.3", info: { title: "Catalog" }, servers: [{ url: "https://api.example.test/v1" }],
      paths: { "/products/{id}": { get: { summary: "Get product", tags: ["Products"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "expand", in: "query", schema: { type: "boolean", default: true } },
      ] }, post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", example: "Lamp" } } } } } }, responses: { 200: {} } } } },
    });
    const collection = store.collections[0];
    expect(collection.name).toBe("Catalog");
    expect(collection.requests).toHaveLength(2);
    expect(collection.requests[0].url).toBe("https://api.example.test/v1/products/:id");
    expect(collection.requests[0].pathParams[0].key).toBe("id");
    expect(collection.requests[0].query[0].value).toBe("true");
    expect(collection.folders[0].name).toBe("Products");
    expect(JSON.parse(collection.requests[1].body.text)).toEqual({ name: "Lamp" });
  });
  test("imports Swagger 2 host, base path, and body schema", () => {
    const store = importOpenApi({ swagger: "2.0", info: { title: "Legacy" }, host: "example.test", basePath: "/api", schemes: ["https"], paths: { "/users/{id}": { post: { parameters: [{ name: "id", in: "path", required: true, type: "string" }, { name: "body", in: "body", schema: { type: "object", properties: { active: { type: "boolean" } } } }], responses: { 200: {} } } } } });
    const request = store.collections[0].requests[0];
    expect(request.url).toBe("https://example.test/api/users/:id");
    expect(JSON.parse(request.body.text)).toEqual({ active: false });
  });
  test("uses an editable base URL when the document has no absolute server", () => {
    const store = importOpenApi({ openapi: "3.0.3", info: { title: "Local" }, servers: [{ url: "/v2" }], paths: { "/ping": { get: { responses: { 200: {} } } } } });
    expect(store.collections[0].variables[0].name).toBe("BASE_URL");
    expect(store.collections[0].requests[0].url).toBe("{{BASE_URL}}/v2/ping");
  });
});
