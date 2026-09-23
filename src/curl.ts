import { entry, newRequest, type ApiRequest } from "./types";

function words(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!quote && /\s/.test(char)) {
      if (started) { result.push(current); current = ""; started = false; }
    } else if (char === "'" && quote !== '"') { quote = quote === "'" ? "" : "'"; started = true; }
    else if (char === '"' && quote !== "'") { quote = quote === '"' ? "" : '"'; started = true; }
    else if (char === "\\" && quote !== "'" && i + 1 < command.length) { current += command[++i]; started = true; }
    else { current += char; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in cURL command");
  if (started) result.push(current);
  return result;
}

export function importCurl(command: string): ApiRequest {
  const args = words(command.trim());
  if (args.shift() !== "curl") throw new Error("Paste a cURL command starting with curl");
  const request = newRequest("Imported cURL request");
  let method = "";
  let data = "";
  let url = "";
  let form = false;
  let getWithData = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = () => { if (!args[i + 1]) throw new Error(`Missing value for ${arg}`); return args[++i]; };
    if (["-X", "--request"].includes(arg)) method = take().toUpperCase();
    else if (["-H", "--header"].includes(arg)) {
      const raw = take(); const colon = raw.indexOf(":");
      if (colon < 1) throw new Error(`Invalid header: ${raw}`);
      request.headers.push({ ...entry(), key: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() });
    } else if (["-d", "--data", "--data-raw", "--data-binary"].includes(arg)) {
      const part = take();
      if (part.startsWith("@")) throw new Error("cURL file bodies are not supported");
      data += (data ? "&" : "") + part;
    }
    else if (["-F", "--form"].includes(arg)) {
      form = true; const pair = take(); const equal = pair.indexOf("=");
      if (equal < 1) throw new Error(`Invalid form field: ${pair}`);
      if (pair.slice(equal + 1).startsWith("@")) throw new Error("cURL file attachments are not supported");
      request.body.fields.push({ ...entry(), key: pair.slice(0, equal), value: pair.slice(equal + 1) });
    } else if (["-u", "--user"].includes(arg)) {
      const user = take(); const colon = user.indexOf(":");
      request.auth = { kind: "basic", username: colon < 0 ? user : user.slice(0, colon), password: colon < 0 ? "" : user.slice(colon + 1), token: "" };
    } else if (arg === "--url") url = take();
    else if (arg === "-G" || arg === "--get") { method = "GET"; getWithData = true; }
    else if (["-s", "-S", "-L", "-k", "--silent", "--show-error", "--location", "--insecure", "--compressed"].includes(arg)) { /* transport flags are not stored */ }
    else if (arg.startsWith("-")) throw new Error(`Unsupported cURL option: ${arg}`);
    else if (!url) url = arg;
    else throw new Error(`Unexpected cURL argument: ${arg}`);
  }
  if (!url) throw new Error("cURL command has no URL");
  request.url = getWithData && data ? `${url}${url.includes("?") ? "&" : "?"}${data}` : url;
  const segments = url.split("/").filter(Boolean);
  request.name = segments[segments.length - 1]?.split("?")[0] || "Imported request";
  request.method = method || (data || form ? "POST" : "GET");
  if (form) request.body.kind = "multipart";
  else if (data && !getWithData) {
    request.body.text = data;
    request.body.kind = request.headers.some((h) => h.key.toLowerCase() === "content-type" && h.value.includes("application/json")) ? "json" : "text";
  }
  return request;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function exportCurl(request: ApiRequest): string {
  const parts = ["curl", "-X", request.method, quote(request.url)];
  request.headers.filter((item) => item.enabled && item.key).forEach((item) => parts.push("-H", quote(`${item.key}: ${item.value}`)));
  if (request.auth.kind === "basic") parts.push("-u", quote(`${request.auth.username}:${request.auth.password}`));
  if (request.auth.kind === "bearer") parts.push("-H", quote(`Authorization: Bearer ${request.auth.token}`));
  if (request.body.kind === "json") parts.push("-H", quote("Content-Type: application/json"), "--data-raw", quote(request.body.text));
  if (request.body.kind === "text") parts.push("--data-raw", quote(request.body.text));
  if (request.body.kind === "multipart") request.body.fields.filter((item) => item.enabled && item.key).forEach((item) => parts.push("-F", quote(`${item.key}=${item.value}`)));
  if (request.body.kind === "form") parts.push("-H", quote("Content-Type: application/x-www-form-urlencoded"), "--data-raw", quote(new URLSearchParams(request.body.fields.filter((item) => item.enabled && item.key).map((item) => [item.key, item.value])).toString()));
  return parts.join(" ");
}
