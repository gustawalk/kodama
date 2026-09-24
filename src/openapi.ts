import { entry, newCollection, newRequest, uid, type Entry, type Store } from "./types";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export function importOpenApi(document: unknown): Store {
  const spec = object(document);
  if (!string(spec.openapi).startsWith("3.") && spec.swagger !== "2.0") {
    throw new Error("Choose an OpenAPI 3 or Swagger 2 JSON document");
  }
  const paths = object(spec.paths);
  const rootServer = string(object(list(spec.servers)[0]).url);
  const scheme = string(list(spec.schemes)[0]) || "https";
  const swaggerBase = string(spec.host) ? `${scheme}://${string(spec.host)}${string(spec.basePath)}` : "";
  const base = rootServer || swaggerBase;
  const title = string(object(spec.info).title) || "Imported API";
  const collection = newCollection(title);
  const byTag = new Map<string, string>();
  const ref = (value: unknown): Json => {
    const candidate = object(value);
    const pointer = string(candidate.$ref);
    if (!pointer.startsWith("#/")) return candidate;
    const resolved = pointer.slice(2).split("/").reduce<unknown>((node, key) => object(node)[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return object(resolved);
  };
  const sample = (schemaValue: unknown, depth = 0): unknown => {
    if (depth > 5) return null;
    const schema = ref(schemaValue);
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (list(schema.enum).length) return list(schema.enum)[0];
    if (schema.type === "array") return [sample(schema.items, depth + 1)];
    if (schema.type === "object" || schema.properties) {
      return Object.fromEntries(Object.entries(object(schema.properties)).map(([key, value]) => [key, sample(value, depth + 1)]));
    }
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return false;
    return "";
  };
  let count = 0;
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = object(pathValue);
    for (const [verb, operationValue] of Object.entries(pathItem)) {
      if (!methods.has(verb)) continue;
      const operation = object(operationValue);
      const route = newRequest(string(operation.summary) || string(operation.operationId) || `${verb.toUpperCase()} ${path}`);
      route.method = verb.toUpperCase();
      route.sourceKey = `${route.method} ${path}`;
      const localServer = string(object(list(operation.servers)[0]).url) || string(object(list(pathItem.servers)[0]).url);
      const pathText = path.replace(/\{([^{}]+)\}/g, ":$1");
      const server = (localServer || base).replace(/\/$/, "");
      for (const match of server.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)) {
        if (!collection.variables.some((variable) => variable.name === match[1])) {
          collection.variables.push({ id: uid(), name: match[1], value: "", secret: false });
        }
      }
      if (!/^https?:\/\//i.test(server) && !collection.variables.some((variable) => variable.name === "BASE_URL")) {
        collection.variables.push({ id: uid(), name: "BASE_URL", value: "", secret: false });
      }
      route.url = `${/^https?:\/\//i.test(server) ? server : `{{BASE_URL}}${server}`}${pathText}`;
      const tag = string(list(operation.tags)[0]);
      if (tag) {
        if (!byTag.has(tag)) {
          const id = uid();
          byTag.set(tag, id);
          collection.folders.push({ id, name: tag, parentId: null });
        }
        route.folderId = byTag.get(tag) ?? null;
      }
      const parameters = [...list(pathItem.parameters), ...list(operation.parameters)].map(ref);
      const rows = new Map<string, Entry>();
      for (const parameter of parameters) {
        const name = string(parameter.name);
        const location = string(parameter.in);
        if (!name || !["path", "query", "header"].includes(location)) continue;
        const row = entry();
        row.key = name;
        const value = parameter.example ?? object(parameter.schema).example ?? object(parameter.schema).default;
        row.value = value === undefined ? "" : String(value);
        rows.set(`${location}:${name}`, row);
      }
      for (const [key, row] of rows) {
        if (key.startsWith("path:")) route.pathParams.push(row);
        else if (key.startsWith("query:")) route.query.push(row);
        else route.headers.push(row);
      }
      const requestBody = ref(operation.requestBody);
      const content = object(requestBody.content);
      const jsonMedia = object(content["application/json"]);
      if (Object.keys(jsonMedia).length) {
        route.body.kind = "json";
        route.body.text = JSON.stringify(jsonMedia.example ?? sample(jsonMedia.schema), null, 2);
      } else {
        const formMedia = object(content["application/x-www-form-urlencoded"]);
        if (Object.keys(formMedia).length) {
          route.body.kind = "form";
          route.body.fields = Object.entries(object(object(formMedia.schema).properties)).map(([key, value]) => ({ ...entry(), key, value: String(sample(value) ?? "") }));
        }
      }
      if (spec.swagger === "2.0") {
        const body = parameters.find((parameter) => parameter.in === "body");
        if (body) { route.body.kind = "json"; route.body.text = JSON.stringify(sample(body.schema), null, 2); }
        const form = parameters.filter((parameter) => parameter.in === "formData");
        if (form.length) { route.body.kind = "form"; route.body.fields = form.map((parameter) => ({ ...entry(), key: string(parameter.name), value: "" })); }
      }
      collection.requests.push(route);
      count++;
    }
  }
  if (!count) throw new Error("No HTTP operations found in this API document");
  return { version: 1, defaults: [], collections: [collection], environments: [], activeEnvironmentId: null };
}
