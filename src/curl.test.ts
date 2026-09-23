import { describe, expect, test } from "bun:test";
import { exportCurl, importCurl } from "./curl";

describe("cURL handoff", () => {
  test("imports a JSON request and preserves variables", () => {
    const request = importCurl("curl -X POST '{{BASE_URL}}/login' -H 'Content-Type: application/json' --data-raw '{\"user\":\"demo\"}'");
    expect(request.method).toBe("POST");
    expect(request.url).toBe("{{BASE_URL}}/login");
    expect(request.body.kind).toBe("json");
    expect(request.body.text).toBe('{"user":"demo"}');
    expect(importCurl(exportCurl(request)).url).toBe(request.url);
  });

  test("rejects options it cannot preserve", () => {
    expect(() => importCurl("curl --proxy http://localhost https://example.com")).toThrow("Unsupported cURL option");
  });
});
