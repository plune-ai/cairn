---
url: /generate
---

# Domain knowledge: Generate CV page

- Three input tabs: **Text** (textarea), **URL** (link field), **File** (drop zone; .md/.txt/.pdf formats).
- The **Generate CV** button is disabled until there is valid input in the current tab.
- Empty input / whitespace only → validation error, generation does not start.
- Invalid URL → error; a valid URL → the system loads the job-posting page.
- Successful generation: a loader is shown, then the generated CV; a record appears in History/Generated.
- XSS in fields must be escaped (the script does not execute).
