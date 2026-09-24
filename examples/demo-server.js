// Run with: bun examples/demo-server.js
// Accounts and tokens live only in memory and reset when this process stops.
const TOKEN_LIFETIME_SECONDS = 900;
const ALLOWED_STATUSES = new Set([200, 201, 400, 404, 418, 500]);

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", ...headers },
});
const failure = (status, code, message, headers = {}) =>
  json({ error: { code, message } }, status, headers);
const accountView = ({ password: _password, ...account }) => account;
const objectBody = async (request) => {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
};

export function createDemoApi() {
  /** @type {Array<{id: string, username: string, password: string, name: string, email: string, createdAt: string}>} */
  const accounts = [];
  accounts.push({ id: "acc-demo", username: "demo", password: "demo", name: "Demo User", email: "demo@example.test", createdAt: new Date().toISOString() });
  const sessions = new Map();
  let nextAccountId = 1;

  const authenticate = (request) => {
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const session = token && sessions.get(token);
    if (!session) return { error: failure(401, "unauthorized", "Send a valid Bearer token from POST /login", { "WWW-Authenticate": "Bearer" }) };
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return { error: failure(401, "token_expired", "Log in again to refresh the token", { "WWW-Authenticate": "Bearer" }) };
    }
    const account = accounts.find((item) => item.id === session.accountId);
    if (!account) return { error: failure(401, "unauthorized", "Account no longer exists", { "WWW-Authenticate": "Bearer" }) };
    return { token, account };
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const accountId = path.match(/^\/accounts\/([^/]+)$/)?.[1];
    const statusCode = path.match(/^\/diagnostics\/status\/(\d{3})$/)?.[1];

    if (path === "/health" && method === "GET") {
      return json({ status: "ok", service: "kodama-demo", timestamp: new Date().toISOString() });
    }
    if (path === "/openapi.json" && method === "GET") {
      return new Response(Bun.file(new URL("./demo-openapi.json", import.meta.url)), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/login" && method === "POST") {
      const body = await objectBody(request);
      if (!body || typeof body.username !== "string" || typeof body.password !== "string") return failure(400, "invalid_body", "Provide username and password as JSON strings");
      const account = accounts.find((item) => item.username === body.username && item.password === body.password);
      if (!account) return failure(401, "invalid_credentials", "Invalid username or password");
      const token = crypto.randomUUID();
      const expiresAt = Date.now() + TOKEN_LIFETIME_SECONDS * 1000;
      sessions.set(token, { accountId: account.id, expiresAt });
      return json({ token, tokenType: "Bearer", expiresInSeconds: TOKEN_LIFETIME_SECONDS, expiresAt: new Date(expiresAt).toISOString() }, 200, { "X-Session-Token": token });
    }
    if (path === "/logout" && method === "POST") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      sessions.delete(auth.token);
      return new Response(null, { status: 204 });
    }
    if ((path === "/me" || path === "/protected") && method === "GET") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      return path === "/me" ? json(accountView(auth.account)) : json({ message: "Authorized", tokenAccepted: true, accountId: auth.account.id });
    }
    if (path === "/accounts" && method === "POST") {
      const body = await objectBody(request);
      const invalid = !body
        || Object.keys(body).some((key) => !["username", "password", "name", "email"].includes(key))
        || typeof body.username !== "string" || !/^[a-z][a-z0-9_]{2,23}$/i.test(body.username)
        || typeof body.password !== "string" || body.password.length < 4 || body.password.length > 72
        || typeof body.name !== "string" || !body.name.trim() || body.name.length > 80
        || (body.email !== undefined && (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)));
      if (invalid) {
        return failure(400, "invalid_body", "Use a 3–24 character username, 4–72 character password, name, and optional email");
      }
      if (accounts.some((item) => item.username.toLowerCase() === body.username.toLowerCase())) return failure(409, "username_taken", "That username already exists");
      const account = { id: `acc-${nextAccountId++}`, username: body.username, password: body.password, name: body.name.trim(), email: body.email ?? "", createdAt: new Date().toISOString() };
      accounts.push(account);
      return json(accountView(account), 201, { Location: `/accounts/${account.id}` });
    }
    if (path === "/accounts" && method === "GET") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return failure(400, "invalid_query", "limit must be 1–100 and offset must be zero or greater");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const filtered = accounts.filter((item) => item.username.toLowerCase().includes(q) || item.name.toLowerCase().includes(q));
      return json({ data: filtered.slice(offset, offset + limit).map(accountView), total: filtered.length, limit, offset });
    }
    if (accountId && method === "GET") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      const account = accounts.find((item) => item.id === accountId);
      return account ? json(accountView(account)) : failure(404, "not_found", "Account not found");
    }
    if (accountId && method === "PATCH") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return failure(404, "not_found", "Account not found");
      const body = await objectBody(request);
      const invalid = !body || !Object.keys(body).length
        || Object.keys(body).some((key) => !["name", "email", "password"].includes(key))
        || (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80))
        || (body.email !== undefined && (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)))
        || (body.password !== undefined && (typeof body.password !== "string" || body.password.length < 4 || body.password.length > 72));
      if (invalid) {
        return failure(400, "invalid_body", "Provide at least one valid name, email, or password field");
      }
      if (body.name !== undefined) account.name = body.name.trim();
      if (body.email !== undefined) account.email = body.email;
      if (body.password !== undefined) account.password = body.password;
      return json(accountView(account));
    }
    if (accountId && method === "DELETE") {
      const auth = authenticate(request);
      if (auth.error) return auth.error;
      if (accountId === "acc-demo") return failure(403, "demo_account", "The demo account cannot be deleted");
      const index = accounts.findIndex((item) => item.id === accountId);
      if (index < 0) return failure(404, "not_found", "Account not found");
      accounts.splice(index, 1);
      for (const [token, session] of sessions) if (session.accountId === accountId) sessions.delete(token);
      return new Response(null, { status: 204 });
    }
    if (path === "/diagnostics/echo" && method === "POST") {
      const body = await request.json().catch(() => null);
      if (body === null) return failure(400, "invalid_json", "Send a JSON body");
      const requestId = crypto.randomUUID();
      return json({ requestId, body, note: request.headers.get("X-Demo-Note"), receivedAt: new Date().toISOString() }, 200, { "X-Request-Id": requestId });
    }
    if (path === "/diagnostics/cookies" && method === "GET") {
      const cookie = request.headers.get("cookie");
      return json({ receivedCookie: cookie, hasDemoCookie: !!cookie?.includes("kodama_demo=seen") }, 200, { "Set-Cookie": "kodama_demo=seen; Path=/; HttpOnly; SameSite=Lax" });
    }
    if (statusCode && method === "GET") {
      const status = Number(statusCode);
      return ALLOWED_STATUSES.has(status) ? json({ status, message: `Demo response ${status}` }, status) : failure(400, "unsupported_status", "Choose 200, 201, 400, 404, 418, or 500");
    }
    const allowed = path === "/accounts" ? "GET, POST" : accountId ? "GET, PATCH, DELETE" : path === "/health" || path === "/openapi.json" || path === "/me" || path === "/protected" || path === "/diagnostics/cookies" || statusCode ? "GET" : path === "/login" || path === "/logout" || path === "/diagnostics/echo" ? "POST" : null;
    return allowed ? failure(405, "method_not_allowed", `Use ${allowed} for this route`, { Allow: allowed }) : failure(404, "not_found", "Route not found");
  };
}

if (import.meta.main) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 8787, fetch: createDemoApi() });
  console.log(`Kodama demo API: ${server.url}`);
  console.log(`OpenAPI: ${server.url}openapi.json`);
}
