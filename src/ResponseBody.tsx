import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
    if (!editor || from === undefined) return;
    editor.dispatch({
      selection: { anchor: from, head: from + query.length },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [query, matches, activeMatch]);

  return <div className="response-body response-editor" ref={host} aria-label="Response body" />;
}
