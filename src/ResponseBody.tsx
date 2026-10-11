import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const responseJsonHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, class: "response-json-key" },
    { tag: tags.string, class: "response-json-string" },
    { tag: tags.number, class: "response-json-number" },
    { tag: [tags.bool, tags.null], class: "response-json-literal" },
  ]),
);

const setSearchDecorations = StateEffect.define<DecorationSet>();
const searchDecorations = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSearchDecorations)) decorations = effect.value;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function findResponseMatches(body: string, query: string): number[] {
  if (!query) return [];
  const matches: number[] = [];
  const haystack = body.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  while ((from = haystack.indexOf(needle, from)) !== -1) {
    matches.push(from);
    from += needle.length;
  }
  return matches;
}

export function ResponseBody({
  body,
  isJson,
  query,
  matches,
  activeMatch,
}: {
  body: string;
  isJson: boolean;
  query: string;
  matches: number[];
  activeMatch: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      state: EditorState.create({
        doc: body,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          searchDecorations,
          ...(isJson ? [json(), responseJsonHighlight] : []),
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [body, isJson]);

  useEffect(() => {
    const editor = view.current;
    const from = matches[activeMatch];
    if (!editor) return;
    const decorations = matches.map((match) =>
      Decoration.mark({
        class: match === from ? "response-search-match active" : "response-search-match",
      }).range(match, match + query.length),
    );
    editor.dispatch({
      effects: setSearchDecorations.of(Decoration.set(decorations)),
    });
    if (from === undefined) return;
    editor.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [query, matches, activeMatch]);

  return <div className="response-body response-editor" ref={host} aria-label="Response body" />;
}
