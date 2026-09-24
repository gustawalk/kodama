import { describe, expect, test } from "bun:test";
import { previewRequestUrl } from "./requestPreview";
import { entry, newRequest } from "./types";

describe("request URL preview", () => {
  test("shows resolved path and enabled query values in the same order as the request", () => {
    const request = newRequest();
    request.url = "{{BASE_URL}}/users/:id?include=profile#details";
    request.pathParams = [{ ...entry(), key: "id", value: "a/b c" }];
    request.query = [
      { ...entry(), key: "page", value: "2" },
      { ...entry(), key: "q", value: "{{SEARCH}}" },
      { ...entry(), key: "disabled", value: "ignored", enabled: false },
    ];
    expect(previewRequestUrl(request, {
      BASE_URL: { value: "https://api.example.test", source: "Environment", secret: false },
      SEARCH: { value: "red lamp", source: "Runtime", secret: false },
    })).toBe("https://api.example.test/users/a%2Fb%20c?include=profile&page=2&q=red%20lamp#details");
  });

  test("keeps unfilled path parameters and unresolved variables visible", () => {
    const request = newRequest();
    request.url = "https://api.example.test/users/:id";
    request.pathParams = [{ ...entry(), key: "id", value: "" }];
    request.query = [{ ...entry(), key: "token", value: "{{_.TOKEN}}" }];
    expect(previewRequestUrl(request, {})).toBe("https://api.example.test/users/:id?token={{_.TOKEN}}");
  });

  test("keeps defined but empty variables visible instead of producing a misleading URL", () => {
    const request = newRequest();
    request.url = "http://localhost:{{PORT}}/v1/health";
    expect(previewRequestUrl(request, { PORT: { value: "", source: "Collection", secret: false } }))
      .toBe("http://localhost:{{PORT}}/v1/health");
  });

  test("keeps random generators visible until send", () => {
    const request = newRequest();
    request.url = "https://api.example.test/items/:id";
    request.pathParams = [{ ...entry(), key: "id", value: "{{random.uuid}}" }];
    expect(previewRequestUrl(request, { "$random.uuid": { value: "Generated when sent", source: "Random", secret: false } }))
      .toBe("https://api.example.test/items/{{random.uuid}}");
  });

  test("encodes spaces as %20 and literal plus signs as %2B", () => {
    const request = newRequest();
    request.url = "https://api.example.test/search?existing=a+b";
    request.query = [{ ...entry(), key: "q", value: "full+ query" }];
    expect(previewRequestUrl(request, {})).toBe("https://api.example.test/search?existing=a+b&q=full%2B%20query");
  });
});
