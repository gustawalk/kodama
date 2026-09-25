import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter } from "@codemirror/lint";
import { indentWithTab } from "@codemirror/commands";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import type { ResolvedVariable } from "./VariableField";
import { getResolvedVariable, variableSuggestions } from "./variableResolution";

type Props = {
  value: string;
  onChange: (value: string) => void;
  language: "json" | "javascript" | "text";
  label: string;
  variables: Record<string, ResolvedVariable>;
  theme: "dark" | "light";
};

export function CodeEditor({ value, onChange, language, label, variables, theme }: Props) {
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
    return [
      EditorState.tabSize.of(2), indentUnit.of("  "), keymap.of([indentWithTab]),
      EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": label }), variableHover,
      autocompletion({ override: [variableCompletion] }),
      ...(language === "json" ? [json(), linter((view) => view.state.doc.toString().trim() ? jsonParseLinter()(view) : []), lintGutter()] : language === "javascript" ? [javascript()] : []),
    ];
  }, [language, variables, label]);
  return <div className="code-editor" aria-label={label}>
    <CodeMirror value={value} onChange={onChange} extensions={extensions} theme={theme} basicSetup={{ autocompletion: false }} />
    <div className="editor-help">Tab indents · Shift+Tab outdents · Esc then Tab moves focus</div>
  </div>;
}
