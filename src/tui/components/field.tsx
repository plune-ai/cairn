import { Box, Text } from "ink";
import TextInput from "ink-text-input";

/** A labelled, controlled text field. `focus` drives whether it captures keystrokes. */
export function Field({
  label,
  value,
  onChange,
  onSubmit,
  focus = true,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  focus?: boolean;
  placeholder?: string;
}) {
  return (
    <Box>
      <Box width={12}>
        <Text>{label}:</Text>
      </Box>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={focus}
        placeholder={placeholder}
      />
    </Box>
  );
}
