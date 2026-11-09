import { Button } from "./Button.js";

export function ChoiceGroup<T extends string>({
  label, value, options, onChange, disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ui-choice-group" role="group" aria-label={label}>
      {options.map(option => (
        <Button key={option.value} variant="ghost" size="sm" disabled={disabled}
          aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </Button>
      ))}
    </div>
  );
}
