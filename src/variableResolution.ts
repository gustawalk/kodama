export type ResolvedVariable = { value: string; source: string; secret: boolean };

export function getResolvedVariable(name: string, variables: Record<string, ResolvedVariable>): ResolvedVariable | undefined {
  return name.startsWith("random.") ? variables[`$${name}`] ?? variables[name] : variables[name];
}

export function variableHasValue(name: string, variables: Record<string, ResolvedVariable>): boolean {
  return !!getResolvedVariable(name, variables)?.value.trim();
}

export type ActiveVariableReference = { start: number; query: string; singleBrace: boolean };

export function activeVariableReference(value: string, caret: number): ActiveVariableReference | null {
  const before = value.slice(0, caret);
  const double = before.lastIndexOf("{{");
  if (double >= 0) {
    const query = before.slice(double + 2);
    if (!/[{}]/.test(query)) return { start: double, query: query.trim().toLowerCase(), singleBrace: false };
  }
  const single = before.lastIndexOf("{");
  if (single < 0 || before[single - 1] === "{") return null;
  const query = before.slice(single + 1);
  return /^\$?rand[^{}]*$/i.test(query)
    ? { start: single, query: query.toLowerCase(), singleBrace: true }
    : null;
}

export function variableSuggestions(active: ActiveVariableReference | null, variables: Record<string, ResolvedVariable>): string[] {
  if (!active) return [];
  const wantsRandom = /^\$?rand/i.test(active.query);
  return [...new Set(Object.entries(variables).flatMap(([name, item]) => {
    if (item.source === "Random") {
      if (!wantsRandom) return [];
      const label = active.query.startsWith("$") ? name : name.replace(/^\$/, "");
      return label.toLowerCase().includes(active.query) ? [label] : [];
    }
    return !active.singleBrace && name.toLowerCase().includes(active.query) ? [name] : [];
  }))].sort().slice(0, 100);
}
