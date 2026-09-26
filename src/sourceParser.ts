export type SourceFile = { path: string; stamp: string; contents: string };
export type ParsedSource = { document: unknown; placeholders: string[]; dependencies: { path: string; stamp: string }[] };
import { parseOpenApiText } from "./openapiRefs";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

export async function parseOpenApiSource(file: SourceFile, read?: (path: string) => Promise<SourceFile>): Promise<ParsedSource> {
  if (/\.(?:json|ya?ml)$/i.test(file.path)) return { document: parseOpenApiText(file.path, file.contents), placeholders: [], dependencies: [] };
  if (!/\.(?:[cm]?js|tsx?)$/i.test(file.path)) throw new Error("Choose a JSON, YAML, JavaScript, or TypeScript OpenAPI source file");

  const ts = await import("typescript");
  const kind = /\.tsx$/i.test(file.path) ? ts.ScriptKind.TSX : /\.ts$/i.test(file.path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file.path, file.contents, ts.ScriptTarget.Latest, true, kind);
  const declarations = new Map<string, import("typescript").Expression>();
  const candidates: Array<{ name: string; node: import("typescript").Expression }> = [];
  const placeholders = new Set<string>();
  const dependencies = new Map<string, string>();
  const loaded = new Set([file.path]);
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        declarations.set(declaration.name.text, declaration.initializer);
        candidates.push({ name: declaration.name.text, node: declaration.initializer });
      }
    } else if (ts.isExportAssignment(statement)) {
      candidates.push({ name: "default", node: statement.expression });
    }
  }
  const rootDirectory = file.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const sourcePath = (from: string, relative: string) => {
    const parts = from.replace(/\\/g, "/").split("/");
    parts.pop();
    for (const part of relative.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  };
  const loadImported = async (from: string, relative: string): Promise<Map<string, import("typescript").Expression> | null> => {
    if (!read || !relative.startsWith(".")) return null;
    const base = sourcePath(from, relative);
    if (!base.startsWith(`${rootDirectory}/`)) return null;
    const paths = /\.(?:[cm]?js|tsx?)$/i.test(base) ? [base] : [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"].map((suffix) => base + suffix);
    let imported: SourceFile | null = null;
    for (const path of paths) {
      try { imported = await read(path); break; }
      catch (cause) { if (cause instanceof Error && !/No such file|not found|os error 2|ENOENT/i.test(cause.message)) throw cause; }
    }
    if (!imported) return null;
    if (loaded.has(imported.path)) return declarations;
    loaded.add(imported.path);
    dependencies.set(imported.path, imported.stamp);
    const importedSource = ts.createSourceFile(imported.path, imported.contents, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(imported.path) ? ts.ScriptKind.TSX : /\.ts$/i.test(imported.path) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const exported = new Map<string, import("typescript").Expression>();
    for (const statement of importedSource.statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        declarations.set(declaration.name.text, declaration.initializer);
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.set(declaration.name.text, declaration.initializer);
      }
      if (ts.isExportAssignment(statement)) exported.set("default", statement.expression);
    }
    for (const statement of importedSource.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const child = await loadImported(imported.path, statement.moduleSpecifier.text);
        if (child && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) for (const binding of statement.importClause.namedBindings.elements) {
          const value = child.get(binding.propertyName?.text ?? binding.name.text);
          if (value) declarations.set(binding.name.text, value);
        }
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const child = await loadImported(imported.path, statement.moduleSpecifier.text);
        if (child) for (const binding of statement.exportClause.elements) {
          const value = child.get(binding.propertyName?.text ?? binding.name.text);
          if (value) exported.set(binding.name.text, value);
        }
      }
    }
    return exported;
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const imported = await loadImported(file.path, statement.moduleSpecifier.text);
      if (imported && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) for (const binding of statement.importClause.namedBindings.elements) {
        const value = imported.get(binding.propertyName?.text ?? binding.name.text);
        if (value) declarations.set(binding.name.text, value);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const imported = await loadImported(file.path, statement.moduleSpecifier.text);
      if (imported) for (const binding of statement.exportClause.elements) {
        const value = imported.get(binding.propertyName?.text ?? binding.name.text);
        if (value) candidates.push({ name: binding.name.text, node: value });
      }
    }
  }
  const error = (node: import("typescript").Node, detail: string): never => {
    const owner = node.getSourceFile();
    const line = owner.getLineAndCharacterOfPosition(node.getStart(owner)).line + 1;
    throw new Error(`${detail} (${owner.fileName.split(/[\\/]/).pop()}:${line})`);
  };
  const dynamicName = (node: import("typescript").Expression): string => {
    if (ts.isIdentifier(node)) return node.text.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (ts.isPropertyAccessExpression(node)) return dynamicName(node.name);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return dynamicName(ts.factory.createIdentifier(node.argumentExpression.text));
    return error(node, "This dynamic expression cannot become a collection variable");
  };
  const visiting = new Set<string>();
  const evaluate = (node: import("typescript").Expression, depth = 0): unknown => {
    if (depth > 40) return error(node, "OpenAPI source is too deeply nested");
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
      return evaluate(node.expression, depth + 1);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)) {
      const value = evaluate(node.operand, depth + 1);
      if (typeof value !== "number") return error(node, "Expected a numeric source value");
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (ts.isIdentifier(node)) {
      const initializer = declarations.get(node.text);
      if (!initializer) {
        const name = dynamicName(node);
        placeholders.add(name);
        return `{{${name}}}`;
      }
      if (visiting.has(node.text)) return error(node, `Circular source constant: ${node.text}`);
      visiting.add(node.text);
      try { return evaluate(initializer, depth + 1); } finally { visiting.delete(node.text); }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = dynamicName(node);
      placeholders.add(name);
      return `{{${name}}}`;
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression, depth + 1);
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return error(span.expression, "Template value must be text or a number");
        result += String(value) + span.literal.text;
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const result: unknown[] = [];
      for (const item of node.elements) {
        if (ts.isSpreadElement(item)) {
          const value = evaluate(item.expression, depth + 1);
          if (!Array.isArray(value)) return error(item, "Array spread must contain a static array");
          result.push(...value);
        } else result.push(evaluate(item, depth + 1));
      }
      return result;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Json = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, depth + 1);
          if (!isObject(spread)) return error(property, "Object spread must contain a static object");
          Object.assign(result, spread);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          result[property.name.text] = evaluate(property.name, depth + 1);
          continue;
        }
        if (!ts.isPropertyAssignment(property)) return error(property, "Only data fields are supported in the OpenAPI document");
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text : error(property.name, "Computed field names are not supported");
        result[key] = evaluate(property.initializer, depth + 1);
      }
      return result;
    }
    return error(node, "This OpenAPI source expression cannot be read safely");
  };

  const ordered = [...candidates].sort((a, b) => Number(/^(openApiDocument|swaggerDocument|default)$/i.test(b.name)) - Number(/^(openApiDocument|swaggerDocument|default)$/i.test(a.name)));
  for (const candidate of ordered) {
    try {
      const document = evaluate(candidate.node);
      if (isObject(document) && (typeof document.openapi === "string" || document.swagger === "2.0") && isObject(document.paths)) {
        return { document, placeholders: [...placeholders], dependencies: [...dependencies].map(([path, stamp]) => ({ path, stamp })) };
      }
    } catch (cause) {
      if (/^(openApiDocument|swaggerDocument|default)$/i.test(candidate.name)) throw cause;
    }
  }
  throw new Error("No exported OpenAPI document with paths was found in this file");
}
