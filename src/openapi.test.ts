import { describe, expect, test } from "bun:test";
import { importOpenApi } from "./openapi";
import demoDocument from "../examples/demo-openapi.json";

describe("OpenAPI import", () => {
  test("imports the demo workflow with Bearer auth and a reviewable login script", () => {
    const collection = importOpenApi(demoDocument).collections[0];
    expect(collection.requests).toHaveLength(14);
    const login = collection.requests.find((request) => request.sourceKey === "POST /login");
    const protectedRoute = collection.requests.find((request) => request.sourceKey === "GET /protected");
    expect(login?.body.text).toContain('"username": "demo"');
    expect(login?.postScript).toBe("_.TOKEN = response.json().token;");
    expect(login?.trusted).toBe(false);
    expect(protectedRoute?.auth).toMatchObject({ kind: "bearer", token: "{{_.TOKEN}}" });
    expect(collection.requests.find((request) => request.sourceKey === "DELETE /accounts/{id}")?.pathParams[0].value).toBe("acc-1");
  });
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
  test("can use route paths as imported request names", () => {
    const document = {
      openapi: "3.0.3", info: { title: "Accounts" },
      paths: { "/health": { get: { summary: "Check server health" } }, "/accounts/{id}": { get: { summary: "Get one account" } } },
    };
    expect(importOpenApi(document).collections[0].requests.map((request) => request.name)).toEqual(["Check server health", "Get one account"]);
    expect(importOpenApi(document, "path").collections[0].requests.map((request) => request.name)).toEqual(["/health", "/accounts/:id"]);
  });
  test("uses an editable base URL when the document has no absolute server", () => {
    const store = importOpenApi({ openapi: "3.0.3", info: { title: "Local" }, servers: [{ url: "/v2" }], paths: { "/ping": { get: { responses: { 200: {} } } } } });
    expect(store.collections[0].variables[0].name).toBe("BASE_URL");
    expect(store.collections[0].requests[0].url).toBe("{{BASE_URL}}/v2/ping");
  });
});
