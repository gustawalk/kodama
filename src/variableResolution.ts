export type ResolvedVariable = { value: string; source: string; secret: boolean };

export function variableHasValue(name: string, variables: Record<string, ResolvedVariable>): boolean {
  return !!variables[name]?.value.trim();
}
