import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter } from "@codemirror/lint";
import { indentWithTab } from "@codemirror/commands";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, WidgetType } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import type { ResolvedVariable } from "./VariableField";
import { getResolvedVariable, variableHasValue, variableSuggestions } from "./variableResolution";

type Props = {
  value: string;
  onChange: (value: string) => void;
  language: "json" | "javascript" | "text";
  label: string;
  large?: boolean;
  variables: Record<string, ResolvedVariable>;
  theme: "dark" | "light";
};

class VariableChip extends WidgetType {
  constructor(readonly name: string, readonly from: number, readonly value: string | undefined) { super(); }
  eq(other: VariableChip) { return this.name === other.name && this.from === other.from && this.value === other.value; }
  toDOM(view: EditorView) {
    const chip = document.createElement("span");
    chip.className = `code-variable-chip${this.value ? "" : " missing"}`;
    chip.textContent = this.name;
    chip.title = this.value ? `${this.name}: ${this.value}` : `${this.name}: Unresolved variable`;
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 2 } });
      view.focus();
    });
    return chip;
  }
}

export function CodeEditor({ value, onChange, language, label, variables, theme, large = false }: Props) {
  const extensions = useMemo(() => {
    const variableCompletion = (context: CompletionContext) => {
      const match = context.matchBefore(/\{\{[^{}]*/);
      if (!match) return null;
      const filter = match.text.slice(2).trim().toLowerCase();
      const names = variableSuggestions({ start: match.from, query: filter, singleBrace: false }, variables);
      return { from: match.from, options: names.map((name) => ({
        label: `{{${name}}}`,
        detail: getResolvedVariable(name, variables)?.source ?? "Random",
        info: getResolvedVariable(name, variables)?.value || "Empty value",
        apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
          const after = view.state.doc.sliceString(to, to + 2);
          view.dispatch({ changes: { from, to: to + (after === "}}" ? 2 : 0), insert: `{{${name}}}` }, selection: { anchor: from + name.length + 4 } });
        },
      })) };
    };
    const variableHover = hoverTooltip((view, pos) => {
      const line = view.state.doc.lineAt(pos);
      for (const match of line.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const from = line.from + (match.index ?? 0);
        const to = from + match[0].length;
        if (pos >= from && pos <= to) {
          const variable = getResolvedVariable(match[1].trim(), variables);
          return { pos: from, end: to, create: () => {
            const dom = document.createElement("div");
            dom.className = `code-variable-tooltip${variable ? "" : " missing"}`;
            const name = document.createElement("code");
            name.textContent = `{{${match[1].trim()}}}`;
            dom.append(name);
            if (variable) {
              const label = document.createElement("small");
              label.textContent = "RESOLVED VALUE";
              const value = document.createElement("span");
              value.textContent = variable.value || "Empty value";
              dom.append(label, value);
            } else {
              const warning = document.createElement("strong");
              warning.textContent = "⚠ Unresolved variable";
              const hint = document.createElement("span");
              hint.textContent = "Define it in defaults, the collection, or the active environment.";
              dom.append(warning, hint);
            }
            return { dom };
          } };
        }
      }
      return null;
    });
    const variableChips = EditorView.decorations.of((view) => {
      const ranges = [];
      const selection = view.state.selection.main;
      for (const { from: visibleFrom, to: visibleTo } of view.visibleRanges) {
        const visible = view.state.doc.sliceString(visibleFrom, visibleTo);
        for (const match of visible.matchAll(/\{\{\s*([^{}\n]+?)\s*\}\}/g)) {
          const from = visibleFrom + (match.index ?? 0);
          const to = from + match[0].length;
          const name = match[1].trim();
          const active = view.hasFocus && (selection.empty
            ? selection.head > from && selection.head < to
            : selection.from < to && selection.to > from);
          if (active) ranges.push(Decoration.mark({ class: `code-variable-active${variableHasValue(name, variables) ? "" : " missing"}` }).range(from, to));
          else ranges.push(Decoration.replace({ widget: new VariableChip(name, from, getResolvedVariable(name, variables)?.value) }).range(from, to));
        }
      }
      return Decoration.set(ranges, true);
    });
    return [
      EditorState.tabSize.of(2), indentUnit.of("  "), keymap.of([indentWithTab]),
      EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": label }), variableHover, variableChips,
      autocompletion({ override: [variableCompletion] }),
      ...(language === "json" ? [json(), linter((view) => view.state.doc.toString().trim() ? jsonParseLinter()(view) : []), lintGutter()] : language === "javascript" ? [javascript()] : []),
    ];
  }, [language, variables, label]);
  return <div className={`code-editor${large ? " large" : ""}`} aria-label={label}>
    <CodeMirror value={value} onChange={onChange} extensions={extensions} theme={theme} basicSetup={{ autocompletion: false }} />
    <div className="editor-help">Tab indents · Shift+Tab outdents · Esc then Tab moves focus</div>
  </div>;
}
