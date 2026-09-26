import yaml from "js-yaml";
import type { SourceFile } from "./sourceParser";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

export function parseOpenApiText(path: string, contents: string): unknown {
  if (/\.json$/i.test(path)) return JSON.parse(contents);
  if (/\.ya?ml$/i.test(path)) return yaml.load(contents);
  throw new Error(`Unsupported OpenAPI reference file: ${path}`);
}

function localPath(from: string, reference: string, rootDirectory: string): string {
  if (/^[a-z]+:\/\//i.test(reference) || reference.startsWith("/") || /^[a-z]:[\\/]/i.test(reference)) {
    throw new Error(`Only relative local OpenAPI references are supported: ${reference}`);
  }
  const parts = from.replace(/\\/g, "/").split("/");
  parts.pop();
  for (const part of reference.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const path = parts.join("/");
  if (!path.startsWith(`${rootDirectory}/`)) throw new Error(`OpenAPI reference leaves the selected source directory: ${reference}`);
  return path;
}

export async function bundleOpenApiRefs(
  root: SourceFile,
  document: unknown,
  read: (path: string) => Promise<SourceFile>,
): Promise<{ document: unknown; dependencies: { path: string; stamp: string }[]; warnings: { path: string; message: string }[] }> {
  const documents = new Map<string, { file: SourceFile; document: unknown; id: number }>();
  const rootDirectory = root.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const external: Record<string, unknown> = {};
  const visiting = new Set<string>();
  const warnings: { path: string; message: string }[] = [];
  const tracked = new Map<string, string>();
  const pointerValue = (value: unknown, pointer: string): unknown => pointer.startsWith("#/")
    ? pointer.slice(2).split("/").reduce<unknown>((node, key) => isObject(node) ? node[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, value)
    : undefined;
  async function process(value: unknown, sourcePath: string, context: string, strict = false): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => process(item, sourcePath, context)));
    if (!isObject(value)) return value;
    const next: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "responses") { next[key] = item; continue; }
      if (key === "$ref" && typeof item === "string" && item.startsWith("#") && sourcePath !== root.path) {
        const source = documents.get(sourcePath);
        if (pointerValue(source?.document, item) !== undefined) next.$ref = `#/x-kodama-external/${source?.id ?? 0}${item.slice(1)}`;
        else if (pointerValue(document, item) !== undefined) next.$ref = item;
        else {
          warnings.push({ path: context, message: `Missing OpenAPI reference ${item} in ${sourcePath} and the root document` });
          return {};
        }
        continue;
      }
      if (key !== "$ref" || typeof item !== "string" || item.startsWith("#")) {
        next[key] = await process(item, sourcePath, context);
        continue;
      }
      try {
        const [relative, pointer = ""] = item.split("#", 2);
        if (!/\.(?:json|ya?ml)$/i.test(relative)) throw new Error(`Unsupported local OpenAPI reference ${item || "(empty)"} in ${sourcePath}`);
        const path = localPath(sourcePath, relative, rootDirectory);
        let found = documents.get(path);
        if (!found) {
          let file: SourceFile;
          try { file = await read(path); }
          catch { tracked.set(path, "missing"); throw new Error(`Missing OpenAPI reference file: ${path}`); }
          tracked.set(file.path, file.stamp);
          let parsed: unknown;
          try { parsed = parseOpenApiText(path, file.contents); }
          catch (cause) { throw new Error(`Invalid OpenAPI reference ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
          found = { file, document: parsed, id: documents.size };
          documents.set(path, found);
        }
        next.$ref = `#/x-kodama-external/${found.id}${pointer ? (pointer.startsWith("/") ? pointer : `/${pointer}`) : ""}`;
        if (!visiting.has(path) && external[String(found.id)] === undefined) {
          visiting.add(path);
          try { external[String(found.id)] = await process(found.document, path, context); }
          finally { visiting.delete(path); }
        }
      } catch (cause) {
        if (strict) throw cause;
        warnings.push({ path: context, message: cause instanceof Error ? cause.message : String(cause) });
        return {};
      }
    }
    return next;
  }
  const rootObject = isObject(document) ? document : {};
  const paths = isObject(rootObject.paths) ? rootObject.paths : {};
  const resolved = await process({ ...rootObject, paths: {}, components: {} }, root.path, "document");
  if (!isObject(resolved)) throw new Error("OpenAPI document must be an object");
  const components: Json = {};
  for (const [group, entries] of Object.entries(isObject(rootObject.components) ? rootObject.components : {})) {
    if (!isObject(entries)) { components[group] = entries; continue; }
    const validEntries: Json = {};
    for (const [name, value] of Object.entries(entries)) {
      try { validEntries[name] = await process(value, root.path, `components/${group}/${name}`); }
      catch (cause) { warnings.push({ path: `components/${group}/${name}`, message: cause instanceof Error ? cause.message : String(cause) }); }
    }
    components[group] = validEntries;
  }
  resolved.components = components;
  const validPaths: Json = {};
  for (const [route, value] of Object.entries(paths)) {
    if (isObject(value) && typeof value.$ref !== "string") {
      const pathItem: Json = {};
      for (const [key, operation] of Object.entries(value)) {
        if (!/^(get|post|put|patch|delete|head|options|trace)$/i.test(key)) { pathItem[key] = operation; continue; }
        try { pathItem[key] = await process(operation, root.path, `${key.toUpperCase()} ${route}`, true); }
        catch (cause) { warnings.push({ path: `${key.toUpperCase()} ${route}`, message: cause instanceof Error ? cause.message : String(cause) }); }
      }
      if (Object.keys(pathItem).some((key) => /^(get|post|put|patch|delete|head|options|trace)$/i.test(key))) validPaths[route] = pathItem;
    } else {
      try { validPaths[route] = await process(value, root.path, route, true); }
      catch (cause) { warnings.push({ path: route, message: cause instanceof Error ? cause.message : String(cause) }); }
    }
  }
  resolved.paths = validPaths;
  if (documents.size) resolved["x-kodama-external"] = external;
  return {
    document: resolved,
    dependencies: [...tracked].map(([path, stamp]) => ({ path, stamp })),
    warnings: warnings.filter((warning, index) => warnings.findIndex((item) => item.path === warning.path && item.message === warning.message) === index),
  };
}
