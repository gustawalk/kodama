import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
  query,
  matches,
  activeMatch,
}: {
  body: string;
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
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [body]);

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
