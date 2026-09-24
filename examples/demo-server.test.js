import { describe, expect, test } from "bun:test";
import { createDemoApi } from "./demo-server.js";

const base = "http://127.0.0.1:8787";
const call = (api, path, options = {}) => api(new Request(`${base}${path}`, options));
const postJson = (body, token) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe("in-memory demo API", () => {
  test("serves health and its OpenAPI document", async () => {
    const api = createDemoApi();
    expect((await (await call(api, "/health")).json()).status).toBe("ok");
    const response = await call(api, "/openapi.json");
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe("3.0.3");
    expect(document.paths["/accounts/{id}"].patch.operationId).toBe("updateAccount");
    const ids = [];
    for (const item of Object.values(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "patch", "delete"].includes(method)) continue;
        ids.push(operation.operationId);
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.$ref) {
        expect(node.$ref.startsWith("#/"), node.$ref).toBe(true);
        const resolved = node.$ref.slice(2).split("/").reduce((value, part) => value?.[part], document);
        expect(resolved, node.$ref).toBeDefined();
      }
      Object.values(node).forEach(visit);
    };
    visit(document);
  });

  test("logs in, protects routes, exposes a response header, and logs out", async () => {
    const api = createDemoApi();
    expect((await call(api, "/protected")).status).toBe(401);
    expect((await call(api, "/login", postJson({ username: "demo", password: "wrong" }))).status).toBe(401);
    const login = await call(api, "/login", postJson({ username: "demo", password: "demo" }));
    const { token, expiresInSeconds } = await login.json();
    expect(expiresInSeconds).toBe(900);
    expect(login.headers.get("X-Session-Token")).toBe(token);
    const authorized = { headers: { Authorization: `Bearer ${token}` } };
    expect((await (await call(api, "/protected", authorized)).json()).tokenAccepted).toBe(true);
    expect((await (await call(api, "/me", authorized)).json()).username).toBe("demo");
    expect((await call(api, "/logout", { ...authorized, method: "POST" })).status).toBe(204);
    expect((await call(api, "/protected", authorized)).status).toBe(401);
  });

  test("creates, searches, updates, and deletes accounts only for this server instance", async () => {
    const api = createDemoApi();
    const created = await call(api, "/accounts", postJson({ username: "alex", password: "demo1234", name: "Alex Lee", email: "alex@example.test" }));
    expect(created.status).toBe(201);
    const account = await created.json();
    expect(account.id).toBe("acc-1");
    expect(account.password).toBeUndefined();
    expect(created.headers.get("Location")).toBe("/accounts/acc-1");
    expect((await call(api, "/accounts", postJson({ username: "alex", password: "demo1234", name: "Again" }))).status).toBe(409);
    const login = await call(api, "/login", postJson({ username: "alex", password: "demo1234" }));
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}` };
    const listed = await (await call(api, "/accounts?q=alex&limit=1&offset=0", { headers })).json();
    expect(listed.total).toBe(1);
    expect(listed.data[0].id).toBe("acc-1");
    const updated = await call(api, "/accounts/acc-1", { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alex Rivera" }) });
    expect((await updated.json()).name).toBe("Alex Rivera");
    expect((await call(api, "/accounts/acc-demo", { method: "DELETE", headers })).status).toBe(403);
    expect((await call(api, "/accounts/acc-1", { method: "DELETE", headers })).status).toBe(204);
    expect((await call(api, "/me", { headers })).status).toBe(401);
    expect((await call(createDemoApi(), "/accounts/acc-1", { headers })).status).toBe(401);
  });

  test("echoes headers, demonstrates cookies, and returns selected statuses", async () => {
    const api = createDemoApi();
    const echo = await call(api, "/diagnostics/echo", { ...postJson({ hello: "world" }), headers: { "Content-Type": "application/json", "X-Demo-Note": "from test" } });
    const echoed = await echo.json();
    expect(echo.headers.get("X-Request-Id")).toBe(echoed.requestId);
    expect(echoed.note).toBe("from test");
    const first = await call(api, "/diagnostics/cookies");
    expect((await first.json()).hasDemoCookie).toBe(false);
    const second = await call(api, "/diagnostics/cookies", { headers: { Cookie: first.headers.get("Set-Cookie").split(";", 1)[0] } });
    expect((await second.json()).hasDemoCookie).toBe(true);
    expect((await call(api, "/diagnostics/status/418")).status).toBe(418);
    expect((await call(api, "/diagnostics/status/999")).status).toBe(400);
  });
});
