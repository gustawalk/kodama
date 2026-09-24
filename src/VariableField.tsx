import { useMemo, useRef, useState } from "react";
import type React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { variableHasValue, type ResolvedVariable } from "./variableResolution";

export type { ResolvedVariable } from "./variableResolution";
type Props = {
  value: string;
  onChange: (value: string) => void;
  variables: Record<string, ResolvedVariable>;
  label: string;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  spellCheck?: boolean;
};

function activeReference(value: string, caret: number) {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start < 0 || before.slice(start).includes("}}")) return null;
  const query = before.slice(start + 2);
  if (query.includes("{") || query.includes("}")) return null;
  return { start, query: query.trim().toLowerCase() };
}

function referenceAtPointer(field: HTMLInputElement | HTMLTextAreaElement, value: string, clientX: number) {
  const style = window.getComputedStyle(field);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.font = style.font;
  const target = clientX - field.getBoundingClientRect().left - Number.parseFloat(style.paddingLeft) + field.scrollLeft;
  const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
  let width = 0;
  let offset = 0;
  for (let index = 0; index < value.length; index++) {
    const charWidth = context.measureText(value[index]).width + letterSpacing;
    if (target <= width + charWidth / 2) { offset = index; break; }
    width += charWidth;
    offset = index + 1;
  }
  for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const start = match.index ?? 0;
    if (offset >= start && offset < start + match[0].length) return match[1].trim();
  }
  return null;
}

export function VariableField({ value, onChange, variables, label, placeholder, className, multiline, spellCheck }: Props) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const [hoveredVariable, setHoveredVariable] = useState<{ name: string; x: number; y: number } | null>(null);
  const active = focused ? activeReference(value, caret) : null;
  const matches = useMemo(() => active
    ? Object.keys(variables).filter((name) => name.toLowerCase().includes(active.query)).sort().slice(0, 100)
    : [], [active?.query, variables]);
  const hasUnresolved = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .some((match) => !variableHasValue(match[1].trim(), variables));
  const showTokens = !multiline && !focused && /\{\{\s*[^{}]+?\s*\}\}/.test(value);
  const tokens = showTokens ? value.split(/(\{\{\s*[^{}]+?\s*\}\})/g) : [];
  const choose = (name: string) => {
    if (!active) return;
    const suffix = value.slice(caret).startsWith("}}") ? 2 : 0;
    const replacement = `{{${name}}}`;
    onChange(value.slice(0, active.start) + replacement + value.slice(caret + suffix));
    const position = active.start + replacement.length;
    setCaret(position);
    setSelected(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(position, position);
    });
  };
  const common = {
    ref: field as never,
    "aria-label": label,
    value,
    placeholder,
    className: [className, hasUnresolved && "unresolved-variable-field", showTokens && "tokenized-input"].filter(Boolean).join(" "),
    "aria-invalid": hasUnresolved || undefined,
    spellCheck,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      setCaret(event.target.selectionStart ?? event.target.value.length);
      setSelected(0);
    },
    onClick: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart ?? 0),
    onMouseMove: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const name = referenceAtPointer(event.currentTarget, value, event.clientX);
      setHoveredVariable(name ? { name, x: event.clientX, y: event.clientY } : null);
    },
    onMouseLeave: () => setHoveredVariable(null),
    onFocus: () => setFocused(true),
    onBlur: () => window.setTimeout(() => setFocused(false), 120),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!matches.length) return;
      if (event.key === "ArrowDown") { event.preventDefault(); setSelected((selected + 1) % matches.length); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelected((selected - 1 + matches.length) % matches.length); }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(matches[selected] ?? matches[0]); }
      if (event.key === "Escape") setFocused(false);
    },
  };
  const control = multiline ? <textarea {...common} /> : <input {...common} />;
  const hoveredValue = hoveredVariable ? variables[hoveredVariable.name] : undefined;
  const hoveredUnset = !!hoveredVariable && !variableHasValue(hoveredVariable.name, variables);
  return <div className="variable-field">
    {control}
    {showTokens && <div className="variable-token-preview" onClick={() => field.current?.focus()} aria-hidden="true">
      {tokens.map((part, index) => {
        const match = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(part);
        if (!match) return <span key={index}>{part}</span>;
        const name = match[1].trim();
        return <span key={index} className={`variable-chip${variableHasValue(name, variables) ? "" : " missing"}`} onMouseMove={(event) => setHoveredVariable({ name, x: event.clientX, y: event.clientY })} onMouseLeave={() => setHoveredVariable(null)}>{name}</span>;
      })}
    </div>}
    {hoveredVariable && <div
      className={`variable-hover-tooltip${hoveredUnset ? " missing" : ""}`}
      role="tooltip"
      style={{ left: Math.max(8, Math.min(hoveredVariable.x + 14, window.innerWidth - 400)), top: Math.max(8, Math.min(hoveredVariable.y + 16, window.innerHeight - 130)) }}
    >
      <code>{`{{${hoveredVariable.name}}}`}</code>
      {hoveredUnset
        ? <div className="variable-hover-warning"><strong><span aria-hidden="true">⚠</span> {hoveredValue ? "No value set" : "Unresolved"}</strong><small>{hoveredValue ? `Set a value in ${hoveredValue.source.toLowerCase()} variables` : "Not defined in the available variables"}</small></div>
        : <div><small>VALUE</small><span>{hoveredValue?.value}</span></div>}
    </div>}
    {!!matches.length && <div className="variable-suggestions" role="listbox" aria-label="Variables">
      {matches.map((name, index) => <Tooltip key={name}>
        <TooltipTrigger asChild><button type="button" role="option" aria-selected={selected === index}
          className={[selected === index && "selected", !variableHasValue(name, variables) && "missing"].filter(Boolean).join(" ")} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}><code>{`{{${name}}}`}</code><span>{variables[name].source}</span></button></TooltipTrigger>
        <TooltipContent>{variables[name].value || "Empty value"}</TooltipContent>
      </Tooltip>)}
    </div>}
  </div>;
}
