import type { ApiRequest } from "./types";
import { variableHasValue, type ResolvedVariable } from "./variableResolution";

const reference = /\{\{\s*([^{}]+?)\s*\}\}/g;
const unresolved = /\{\{[^{}]+\}\}/;

export function previewRequestUrl(request: ApiRequest, variables: Record<string, ResolvedVariable>): string {
  const resolve = (text: string) => text.replace(reference, (raw, name: string) => {
    const variable = variables[name.trim()];
    return variableHasValue(name.trim(), variables) && variable.source !== "Random" ? variable.value : raw;
  });
  const url = resolve(request.url);
  if (!url) return "";
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const existingQuery = queryAt < 0 ? "" : beforeHash.slice(queryAt);
  const filledPath = path.replace(/\/:([A-Za-z_][\w]*)(?=\/|$)/g, (segment, name: string) => {
    const row = (request.pathParams ?? []).find((item) => item.enabled && item.key === name);
    if (!row?.value) return segment;
    const value = resolve(row.value);
    return value ? `/${unresolved.test(value) ? value : encodeURIComponent(value)}` : segment;
  });
  const encode = (value: string) => unresolved.test(value) ? value : new URLSearchParams([["value", value]]).toString().slice(6);
  const query = request.query
    .filter((row) => row.enabled && row.key.trim())
    .map((row) => `${encode(resolve(row.key))}=${encode(resolve(row.value))}`)
    .join("&");
  const separator = !query ? "" : !existingQuery ? "?" : /[?&]$/.test(existingQuery) ? "" : "&";
  return `${filledPath}${existingQuery}${separator}${query}${hash}`;
}
