import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = { value: string; label: string };

/** Sentinel so the "nothing selected" state gets a real, checkable item. */
const EMPTY_VALUE = "__styled_select_empty__";

type StyledSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown in the trigger while nothing is selected, when no empty item is rendered. */
  placeholder?: string;
  /** Label for a checkable "nothing selected" item, e.g. "No environment". */
  emptyItemLabel?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
};

/**
 * A themed dropdown built on Radix Select. Native `<select>` option lists are drawn by the OS
 * and ignore CSS, so this renders a portaled listbox that follows the app themes.
 */
export function StyledSelect({
  value,
  onChange,
  options,
  placeholder,
  emptyItemLabel,
  className,
  id,
  ariaLabel,
}: StyledSelectProps) {
  const empty = value === "";
  const radixValue = empty && emptyItemLabel ? EMPTY_VALUE : value;
  const items: SelectOption[] = emptyItemLabel
    ? [{ value: EMPTY_VALUE, label: emptyItemLabel }, ...options]
    : options;
  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={`styled-select-trigger${className ? ` ${className}` : ""}`}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="styled-select-chevron">
          <ChevronDown size={14} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="styled-select-menu" position="popper" sideOffset={6}>
          <SelectPrimitive.Viewport>
            {items.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="styled-select-item"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={13} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
