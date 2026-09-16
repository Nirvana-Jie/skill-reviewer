---
name: note-taker
description: >-
  Turn a pasted meeting transcript into structured notes with decisions and
  action items. Use when the user pastes a transcript or points at a transcript
  file and asks for notes, minutes, decisions, or action items. Do NOT trigger
  for summarising articles, emails, or documents that are not meeting records.
---

# Note Taker

## When to use

Trigger when the user supplies a meeting transcript (pasted or a file path) and
asks for notes, minutes, decisions, or action items.

## Workflow

1. Read the transcript. If it is empty or is not a meeting record, say so and stop.
2. List decisions as one line each, quoting the speaker when named.
3. List action items as `owner — action — due date (or "unspecified")`.
4. Return the sections below; omit a section only when it is empty and say "none".

## Output

```
## Decisions
- ...
## Action items
- owner — action — due
## Open questions
- ...
```

## Evals

Executable cases live in `evals/evals.json`.
