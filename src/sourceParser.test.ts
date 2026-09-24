import { describe, expect, test } from "bun:test";
import { parseOpenApiSource } from "./sourceParser";
import { importOpenApi } from "./openapi";

describe("OpenAPI source parser", () => {
  test("reads a TypeScript document without running imports or helpers", async () => {
    const parsed = await parseOpenApiSource({ path: "/project/src/openapi.ts", stamp: "1", contents: `
      import { env } from "../config/env";
      export const openApiDocument = {
        openapi: "3.0.3",
        info: { title: "Chat Service API", version: "1.0.0" },
        servers: [{ url: \`http://localhost:\${env.PORT}\` }],
        paths: { "/v1/health": { get: { summary: "Health", responses: { "200": { description: "ok" } } } } }
      } as const;
      export const renderScalarHtml = () => { throw Error("must never run"); };
    ` });
    expect(parsed.placeholders).toEqual(["PORT"]);
    expect((parsed.document as { servers: { url: string }[] }).servers[0].url).toBe("http://localhost:{{PORT}}");
    const collection = importOpenApi(parsed.document).collections[0];
    expect(collection.variables[0].name).toBe("PORT");
    expect(collection.requests[0].url).toBe("http://localhost:{{PORT}}/v1/health");
  });

  test("rejects executable expressions inside the document", async () => {
    await expect(parseOpenApiSource({ path: "openapi.ts", stamp: "2", contents: `export const openApiDocument = { openapi: "3.0.3", paths: makeRoutes() };` })).rejects.toThrow("cannot be read safely");
  });
});
