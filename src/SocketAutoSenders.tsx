import { lazy, Suspense, useState } from "react";
import type { SocketAutoSender } from "./types";
import { uid } from "./types";
import type { ResolvedVariable } from "./VariableField";
import { VariableField } from "./VariableField";
import { StyledSelect } from "./StyledSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";

const CodeEditor = lazy(() =>
  import("./CodeEditor").then((module) => ({ default: module.CodeEditor })),
);

type Props = {
  schedules: SocketAutoSender[];
  onChange: (schedules: SocketAutoSender[]) => void;
  isIo: boolean;
  variables: Record<string, ResolvedVariable>;
  theme: "dark" | "light";
  connected: boolean;
  suspended: Set<string>;
};

export function SocketAutoSenders({
  schedules,
  onChange,
  isIo,
  variables,
  theme,
  connected,
  suspended,
}: Props) {
  const [draft, setDraft] = useState<SocketAutoSender | null>(null);
  const [interval, setInterval] = useState("30");
  const validInterval =
    /^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= 2147483647;
  const canSave = !!draft?.name.trim() && validInterval && (!isIo || !!draft.event.trim());
  const edit = (sender?: SocketAutoSender) => {
    setDraft(
      sender
        ? { ...sender }
        : {
            id: uid(),
            name: "",
            enabled: false,
            intervalSeconds: 30,
            event: "ping",
            payload: "{}",
            format: "json",
          },
    );
    setInterval(String(sender?.intervalSeconds ?? 30));
  };
  const patch = (change: Partial<SocketAutoSender>) =>
    setDraft((previous) => previous && { ...previous, ...change });
  return (
    <details className="socket-auto-senders">
      <summary>
        Auto sender <span>{schedules.length ? `(${schedules.length})` : ""}</span>
      </summary>
      <p className="hint">Enabled messages repeat while connected, starting after one interval.</p>
      <div className="socket-schedule-list">
        {schedules.map((sender) => (
          <div className="socket-schedule" key={sender.id}>
            <input
              type="checkbox"
              aria-label={`Enable ${sender.name}`}
              checked={sender.enabled}
              onChange={(event) =>
                onChange(
                  schedules.map((item) =>
                    item.id === sender.id ? { ...item, enabled: event.target.checked } : item,
                  ),
                )
              }
            />
            <div className="socket-schedule-description">
              <strong>{sender.name}</strong>
              <span>
                {isIo ? `${sender.event} · ` : ""}Every {sender.intervalSeconds}s ·{" "}
                {sender.enabled
                  ? connected
                    ? suspended.has(sender.id)
                      ? "Suspended — change settings to retry"
                      : "Running"
                    : "Starts on connection"
                  : "Disabled"}
              </span>
            </div>
            <button className="subtle small" onClick={() => edit(sender)}>
              Edit
            </button>
            <button
              className="icon"
              aria-label={`Delete ${sender.name}`}
              onClick={() => onChange(schedules.filter((item) => item.id !== sender.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => edit()}>
        + Add recurring message
      </button>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      >
        <DialogContent className="socket-schedule-dialog">
          <DialogHeader>
            <DialogTitle>
              {schedules.some((sender) => sender.id === draft?.id)
                ? "Edit recurring message"
                : "Add recurring message"}
            </DialogTitle>
            <DialogDescription>
              Send an application message at a regular interval. Variables resolve each time it
              sends.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSave) return;
                const next = {
                  ...draft,
                  name: draft.name.trim(),
                  intervalSeconds: Number(interval),
                };
                onChange(
                  schedules.some((sender) => sender.id === next.id)
                    ? schedules.map((sender) => (sender.id === next.id ? next : sender))
                    : [...schedules, next],
                );
                setDraft(null);
              }}
            >
              <label className="socket-field">
                Name
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="Keepalive"
                  required
                />
              </label>
              <label className="socket-field">
                Interval (seconds)
                <input
                  type="number"
                  min="1"
                  max="2147483647"
                  step="1"
                  value={interval}
                  onChange={(event) => setInterval(event.target.value)}
                  required
                  aria-invalid={!validInterval}
                />
              </label>
              {isIo && (
                <label className="socket-field">
                  Event name
                  <VariableField
                    label="Recurring event name"
                    variables={variables}
                    value={draft.event}
                    onChange={(event) => patch({ event })}
                  />
                </label>
              )}
              <div className="socket-format">
                <span>Payload</span>
                <StyledSelect
                  value={draft.format}
                  ariaLabel="Recurring payload format"
                  options={[
                    { value: "json", label: "JSON" },
                    { value: "text", label: "Text" },
                  ]}
                  onChange={(format) => patch({ format: format as "json" | "text" })}
                />
              </div>
              <Suspense fallback={<div className="code-editor-loading">Loading editor…</div>}>
                <CodeEditor
                  label="Recurring message payload"
                  variables={variables}
                  theme={theme}
                  language={draft.format}
                  value={draft.payload}
                  onChange={(payload) => patch({ payload })}
                />
              </Suspense>
              <label className="socket-schedule-enabled">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                Enable while connected
              </label>
              <DialogFooter>
                <button type="button" className="subtle" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button className="send" type="submit" disabled={!canSave}>
                  Save message
                </button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </details>
  );
}
