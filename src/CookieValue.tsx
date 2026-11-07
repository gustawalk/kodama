import { useId, useState } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { toast } from "sonner";

const COOKIE_PREVIEW_LENGTH = 80;

export function CookieValue({ name, value }: { name: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const long = value.length > COOKIE_PREVIEW_LENGTH;
  return (
    <div className="cookie-value">
      <div className="cookie-value-content">
        <span id={contentId}>
          <code className="break-all">
            {value
              ? long && !expanded
                ? value.slice(0, COOKIE_PREVIEW_LENGTH) + "…"
                : value
              : "(empty)"}
          </code>
          {long && !expanded && (
            <span className="cookie-char-count"> · {value.length.toLocaleString()} characters</span>
          )}
        </span>
      </div>
      <div className="cookie-entry-actions">
        <button
          className="cookie-copy"
          aria-label={`Copy value for ${name}`}
          title="Copy cookie value"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => toast.success("Cookie value copied"),
              () => toast.error("Could not copy cookie value"),
            );
          }}
        >
          <Copy size={14} />
        </button>
        {long && (
          <button
            className="cookie-copy"
            aria-label={`${expanded ? "Collapse" : "Expand"} value for ${name}`}
            title={expanded ? "Collapse value" : "Expand value"}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
