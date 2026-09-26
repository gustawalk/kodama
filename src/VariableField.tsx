import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { activeVariableReference, getResolvedVariable, variableHasValue, variableSuggestions, type ResolvedVariable } from "./variableResolution";

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
  const suggestionsList = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const [hoveredVariable, setHoveredVariable] = useState<{ name: string; x: number; y: number } | null>(null);
  const [suggestionStyle, setSuggestionStyle] = useState<React.CSSProperties>();
  const active = focused ? activeVariableReference(value, caret) : null;
  const matches = useMemo(() => variableSuggestions(active, variables), [active?.query, active?.singleBrace, variables]);
  useLayoutEffect(() => {
    if (!focused || !matches.length || !field.current) return;
    const positionMenu = () => {
      const rect = field.current?.getBoundingClientRect();
      if (!rect) return;
      const below = Math.max(0, window.innerHeight - rect.bottom - 8);
      const above = Math.max(0, rect.top - 8);
      const placeAbove = below < 180 && above > below;
      const available = placeAbove ? above : below;
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
      const menuMaxHeight = Math.min(190, available);
      setSuggestionStyle({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: placeAbove ? Math.max(8, rect.top - menuMaxHeight) : rect.bottom,
        width,
        maxHeight: menuMaxHeight,
      });
    };
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && suggestionsList.current?.contains(event.target)) return;
      positionMenu();
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [focused, matches.length]);
  useLayoutEffect(() => {
    suggestionsList.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, matches.length, suggestionStyle]);
  const hasUnresolved = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .some((match) => !variableHasValue(match[1].trim(), variables));
  const showTokens = !multiline && !focused && /\{\{\s*[^{}]+?\s*\}\}/.test(value);
  const tokens = showTokens ? value.split(/(\{\{\s*[^{}]+?\s*\}\})/g) : [];
  const choose = (name: string) => {
    if (!active) return;
    const suffix = value.slice(caret).startsWith("}}") ? 2 : active.singleBrace && value.slice(caret).startsWith("}") ? 1 : 0;
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
  const hoveredValue = hoveredVariable ? getResolvedVariable(hoveredVariable.name, variables) : undefined;
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
    {!!matches.length && suggestionStyle && createPortal(<div ref={suggestionsList} className="variable-suggestions" style={suggestionStyle} role="listbox" aria-label="Variables">
      {matches.map((name, index) => <button key={name} type="button" role="option" aria-selected={selected === index}
          className={[selected === index && "selected", !variableHasValue(name, variables) && "missing"].filter(Boolean).join(" ")} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}>
            <code className="variable-suggestion-name">{name}</code>
            <span className="variable-suggestion-separator" aria-hidden="true">—</span>
            <span className="variable-suggestion-value">{getResolvedVariable(name, variables)?.secret ? "••••••" : getResolvedVariable(name, variables)?.value || "Empty value"}</span>
          </button>)}
    </div>, document.body)}
  </div>;
}
