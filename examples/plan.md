# Test plan — Cairn landing page (https://plune.ai/cairn)
#
# Example checklist for:  cairn design --url https://plune.ai/cairn --checklist examples/plan.md
# It steers WHAT the bot tests and is scored as coverage.
#
# Format: one test intent per bullet (`-`). Lines starting with `#` are notes and are ignored.
# Do NOT use `##` headings here — a `##` line flips the parser into "headings-as-items" mode and
# your bullets are dropped. Single `#` lines (like these) are safe section dividers.

# Header & navigation
- The top navigation shows the Platform, Docs, Blog and Cairn links
- The "Get started" button in the header is visible and clickable
- The "GitHub" link points to the project repository
- Clicking the "Plune" logo returns to the home page

# Hero
- The hero shows the "Cairn" heading and the tagline "An AI that walks your system and leaves a trail of tests"
- The Node.js, TypeScript and Playwright tech badges are visible
- The Explore / Design / Automate anchors scroll to their sections

# Content sections
- The 5-stage pipeline (Observe, Ground, Design, Generate & validate, Judge & learn) is visible
- The Human-in-the-loop section explains ATC (automatable) vs MTC (manual) cases
- Each of the three modes (design, automate, explore) shows an example command
- Every command block has a working "copy" button
- The Quickstart section lists the numbered steps 1–6

# Install & docs
- The install section shows the npm command and the "Node 20+ · Apache-2.0 · v0.3.0" version line
- The "Read the docs" link opens the documentation
- The "Next: evaluate & gate your app with the Plune platform" call-to-action is present

# Footer
- The footer shows the Product, Docs and Company link columns
- The newsletter field accepts a valid email address
- The newsletter field rejects an invalid email (e.g. "abc") with a validation message
- The "All systems operational" status indicator is visible
- The theme toggle switches between light and dark
