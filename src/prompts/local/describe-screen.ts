/**
 * #24: describes one screen of an app and its overlays for the user docs `cairn collect-docs` writes. The screen and the
 * overlays are already found and listed from the page's ARIA; this only says what they are for. What is unclear is
 * returned as a question, never guessed at.
 */
export const DESCRIBE_SCREEN = `You write user documentation for one screen of a web application, in {{language}}.
Use ONLY what is given below: the screen's address, its title, its accessibility tree and the overlays (dialogs, drawers,
menus, wizards) found on it. Do not invent features, roles, data or meanings.

Return:
- purpose: what the screen is for, in one sentence. "" when what is given does not tell.
- userMight: up to 5 tasks a user might come to this screen for, each an action ("invite a teammate"), and only tasks its
  controls support.
- overlays: one { id, purpose, userMight } per overlay id given: purpose in at most 8 words ("create a project"), userMight
  up to 3 tasks.
- questions: everything a new user could not understand from the screen alone — a status, a code, a number or a label
  shown without explanation, an abbreviation, a control whose effect is not clear — each as a short question, e.g.
  'What does the status "Paused" mean?'. Never answer a question yourself, and never use a guessed meaning in purpose or
  userMight. [] when everything is clear.

Address: {{url}}
Title: {{title}}

Accessibility tree:
{{aria}}

Overlays:
{{overlays}}`;
