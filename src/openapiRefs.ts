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
): Promise<{ document: unknown; dependencies: { path: string; stamp: string }[] }> {
  const documents = new Map<string, { file: SourceFile; document: unknown; id: number }>();
  const rootDirectory = root.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const external: Record<string, unknown> = {};
  const visiting = new Set<string>();
  async function process(value: unknown, sourcePath: string): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => process(item, sourcePath)));
    if (!isObject(value)) return value;
    const next: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#") && sourcePath !== root.path) {
        const source = documents.get(sourcePath);
        next.$ref = `#/x-kodama-external/${source?.id ?? 0}${item.slice(1)}`;
        continue;
      }
      if (key !== "$ref" || typeof item !== "string" || item.startsWith("#")) {
        next[key] = await process(item, sourcePath);
        continue;
      }
      const [relative, pointer = ""] = item.split("#", 2);
      if (!/\.(?:json|ya?ml)$/i.test(relative)) throw new Error(`Unsupported local OpenAPI reference: ${item}`);
      const path = localPath(sourcePath, relative, rootDirectory);
      let found = documents.get(path);
      if (!found) {
        const file = await read(path);
        found = { file, document: parseOpenApiText(path, file.contents), id: documents.size };
        documents.set(path, found);
      }
      next.$ref = `#/x-kodama-external/${found.id}${pointer ? (pointer.startsWith("/") ? pointer : `/${pointer}`) : ""}`;
      if (!visiting.has(path) && external[String(found.id)] === undefined) {
        visiting.add(path);
        external[String(found.id)] = await process(found.document, path);
        visiting.delete(path);
      }
    }
    return next;
  }
  const resolved = await process(document, root.path);
  if (!isObject(resolved)) throw new Error("OpenAPI document must be an object");
  if (documents.size) resolved["x-kodama-external"] = external;
  return { document: resolved, dependencies: [...documents.values()].map(({ file }) => ({ path: file.path, stamp: file.stamp })) };
}
