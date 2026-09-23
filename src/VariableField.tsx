import { useMemo, useRef, useState } from "react";
import type React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ResolvedVariable = { value: string; source: string; secret: boolean };
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
    className,
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
  return <div className="variable-field">
    {control}
    {hoveredVariable && <div
      className={`variable-hover-tooltip${hoveredValue ? "" : " missing"}`}
      role="tooltip"
      style={{ left: Math.max(8, Math.min(hoveredVariable.x + 12, window.innerWidth - 310)), top: Math.max(8, Math.min(hoveredVariable.y + 14, window.innerHeight - 105)) }}
    >
      <code>{`{{${hoveredVariable.name}}}`}</code>
      {hoveredValue
        ? <div><small>VALUE</small><span>{hoveredValue.value || "Empty value"}</span></div>
        : <div className="variable-hover-warning"><strong><span aria-hidden="true">⚠</span> Unresolved</strong><small>Not defined in the available variables</small></div>}
    </div>}
    {!!matches.length && <div className="variable-suggestions" role="listbox" aria-label="Variables">
      {matches.map((name, index) => <Tooltip key={name}>
        <TooltipTrigger asChild><button type="button" role="option" aria-selected={selected === index}
          className={selected === index ? "selected" : ""} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}><code>{`{{${name}}}`}</code><span>{variables[name].source}</span></button></TooltipTrigger>
        <TooltipContent>{variables[name].value || "Empty value"}</TooltipContent>
      </Tooltip>)}
    </div>}
  </div>;
}
