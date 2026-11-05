/**
 * Names what each overlay found by exploration is for (#225). The overlays are already found and described from the
 * page's ARIA; this only gives each one a short purpose for cases and docs. It never decides what is an overlay.
 */
export const NAME_OVERLAYS = `For each overlay below (a dialog, drawer, menu or wizard of a web page), write what it is FOR in at most 8 words,
in {{language}}, as an action a user takes, e.g. "create a project", "confirm discarding changes", "pick a row action".
Use only what is given: the page purpose, what opened the overlay, its name and its elements. Do not invent features.

Page purpose:
{{pageSemantics}}

Overlays:
{{overlays}}

Return one { id, purpose } per overlay id given.`;
