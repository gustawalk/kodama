// Run with: bun examples/demo-server.js
// Local-only test API for the bundled Kodama demo collection.
const tokens = new Set();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/login" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (body?.username !== "demo" || body?.password !== "demo") {
        return Response.json({ error: "Invalid credentials" }, { status: 401 });
      }
      const token = crypto.randomUUID();
      tokens.add(token);
      return Response.json({ token, expiresInSeconds: 900 });
    }
    if (url.pathname === "/protected" && request.method === "GET") {
      const token = request.headers.get("authorization")?.replace(
        /^Bearer\s+/i,
        "",
      );
      return tokens.has(token)
        ? Response.json({ message: "Authorized", tokenAccepted: true })
        : Response.json({ error: "Missing or invalid token" }, { status: 401 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
console.log(`Kodama demo API: ${server.url}`);
