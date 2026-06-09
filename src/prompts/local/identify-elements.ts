/**
 * Page analysis prompt (identifyElements). New (not from qa-skills).
 * The vision image is passed as a separate content block; this is the text part.
 */
export const IDENTIFY_ELEMENTS = `You are an experienced QA engineer. Analyze the web page.

ARIA snapshot:
{{ariaYaml}}

Detected elements (ref · role · name):
{{elements}}

Tasks:
1. pageSemantics — briefly (1–2 sentences) describe what this screen is and its main purpose.
2. primaryRefs — pick the refs of the most test-worthy elements. Use ONLY refs from the provided
   list — do not invent new ones or change them.
3. viewSwitchers — refs of view switchers: tabs, wizard steps, filter/mode toggles, form switchers —
   whose click OPENS DIFFERENT content (rather than performing an action). Only from the provided list; empty if none.

Return structured output.`;
