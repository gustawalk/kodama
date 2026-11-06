import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { CookieValue } from "./CookieValue";
type Row = { name: string; value: string; enabled: boolean };
export function CookieManager({ url, revision }: { url: string; revision: unknown }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const originalRow = useRef<Row | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const scope = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    scope.current += 1;
    rowsRef.current = [];
    setRows([]);
    setEditing(null);
    setError("");
    void invoke<Row[]>("manage_cookies", { url, rows: null }).then(
      (value) => {
        if (active) {
          rowsRef.current = value;
          setRows(value);
        }
      },
      (err) => {
        if (active) setError(String(err));
      },
    );
    return () => {
      active = false;
    };
  }, [url, revision]);
  const change = (next: Row[]) => {
    rowsRef.current = next;
    setRows(next);
    const generation = scope.current;
    // Keep unnamed drafts in the editor, but never send them as cookies.
    const cookies = next.filter((row) => row.name.length > 0);
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          await invoke<Row[]>("manage_cookies", { url, rows: cookies });
          if (scope.current === generation) setError("");
        } catch (err) {
          if (scope.current === generation)
            setError(`Cookie changes could not be applied: ${String(err)}`);
        }
      });
  };
  const edit = (index: number, patch: Partial<Row>) =>
    change(rowsRef.current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="response-cookies">
      <div className="cookie-heading">
        <strong>Session cookies</strong>
      </div>
      <p>{url || "Enter a request URL to manage cookies."}</p>
      <p>Changes apply automatically. Unchecked cookies won’t be sent.</p>
      {error && <p role="alert">{error}</p>}
      <div className="manual-cookie-list">
        <div className="manual-cookie-labels">
          <div className="">
            <span>Name</span>
          </div>
          <div className="ml-8">
            <span>Value</span>
          </div>
        </div>
        {rows.map((row, index) => (
          <div className="manual-cookie-row" key={index}>
            <input
              type="checkbox"
              aria-label={`Enable cookie ${index + 1}`}
              checked={row.enabled}
              onChange={(e) => edit(index, { enabled: e.target.checked })}
            />
            {editing === index ? (
              <div className="manual-cookie-editor">
                <input
                  autoFocus
                  aria-label={`Cookie name ${index + 1}`}
                  placeholder="Name"
                  value={row.name}
                  onChange={(e) => edit(index, { name: e.target.value })}
                />
                <textarea
                  aria-label={`Cookie value ${index + 1}`}
                  placeholder="Value"
                  rows={3}
                  value={row.value}
                  onChange={(e) => edit(index, { value: e.target.value })}
                />
              </div>
            ) : (
              <>
                <code className="manual-cookie-name">{row.name || "Unnamed"}</code>
                <CookieValue key={`${index}-${row.name}`} name={row.name} value={row.value} />
              </>
            )}
            <div className="manual-cookie-tools">
              <button
                className="icon"
                aria-label={`${editing === index ? "Finish editing" : "Edit"} cookie ${index + 1}`}
                title={editing === index ? "Done" : "Edit cookie"}
                onClick={() => {
                  if (editing === index) {
                    setEditing(null);
                    originalRow.current = null;
                  } else {
                    originalRow.current = { ...rowsRef.current[index] };
                    setEditing(index);
                  }
                }}
              >
                {editing === index ? <Check size={14} /> : <Pencil size={14} />}
              </button>
              {editing === index && (
                <button
                  className="icon"
                  aria-label={`Cancel editing cookie ${index + 1}`}
                  title="Cancel editing"
                  onClick={() => {
                    const original = originalRow.current;
                    change(
                      original
                        ? rowsRef.current.map((row, i) => (i === index ? original : row))
                        : rowsRef.current.filter((_, i) => i !== index),
                    );
                    setEditing(null);
                    originalRow.current = null;
                  }}
                >
                  <X size={14} />
                </button>
              )}
              <button
                className="icon"
                aria-label={`Delete cookie ${index + 1}`}
                onClick={() => {
                  change(rowsRef.current.filter((_, i) => i !== index));
                  setEditing(null);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="cookie-actions">
        <button
          className="subtle small"
          onClick={() => {
            originalRow.current = null;
            setEditing(rows.length);
            change([...rowsRef.current, { name: "", value: "", enabled: true }]);
          }}
        >
          + Add cookie
        </button>
      </div>
    </div>
  );
}
