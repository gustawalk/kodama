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

export function VariableField({ value, onChange, variables, label, placeholder, className, multiline, spellCheck }: Props) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const active = focused ? activeReference(value, caret) : null;
  const matches = useMemo(() => active
    ? Object.keys(variables).filter((name) => name.toLowerCase().includes(active.query)).sort().slice(0, 100)
    : [], [active?.query, variables]);
  const names = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim());

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
  return <div className="variable-field">
    {names.length ? <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent className="variable-field-tooltip">
        {[...new Set(names)].map((name) => <div key={name}><code>{`{{${name}}}`}</code><span>{variables[name]?.value || (variables[name] ? "Empty value" : "Unresolved variable")}</span></div>)}
      </TooltipContent>
    </Tooltip> : control}
    {!!matches.length && <div className="variable-suggestions" role="listbox" aria-label="Variables">
      {matches.map((name, index) => <Tooltip key={name}>
        <TooltipTrigger asChild><button type="button" role="option" aria-selected={selected === index}
          className={selected === index ? "selected" : ""} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}><code>{`{{${name}}}`}</code><span>{variables[name].source}</span></button></TooltipTrigger>
        <TooltipContent>{variables[name].value || "Empty value"}</TooltipContent>
      </Tooltip>)}
    </div>}
    {!!names.length && <div className="variable-references">{[...new Set(names)].map((name) => <Tooltip key={name}>
      <TooltipTrigger asChild><span className={variables[name] ? "variable-reference" : "variable-reference missing"}>{`{{${name}}}`}</span></TooltipTrigger>
      <TooltipContent>{variables[name] ? variables[name].value || "Empty value" : "Unresolved variable"}</TooltipContent>
    </Tooltip>)}</div>}
  </div>;
}
