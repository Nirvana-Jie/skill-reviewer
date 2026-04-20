---
name: csv-column-renamer
description: >-
  Rename one or more columns in a CSV file in place or to a new path, keeping
  row order and cell values untouched. Use when the user points at a specific
  CSV (by path, filename, or pasted content) and asks to rename / relabel /
  change the header of one or more columns, including requests like "change
  the column `foo` to `bar`", "the header says revenue but should say sales",
  or "make these column names snake_case". Do NOT trigger for general CSV
  editing (row filtering, deduplication, type coercion), for creating a new
  CSV, for Excel `.xlsx` files, or when the user has not identified which
  column to rename.
---

# CSV Column Renamer

## When to use

Trigger only when all three are true:
1. The user has identified a specific CSV file (path, filename, or pasted content).
2. The user wants to change one or more **column names**, not cell contents.
3. The format is CSV (not `.xlsx`, not a database table).

If the user wants to filter rows, change values, or convert types, decline and suggest a different tool.

## Workflow

1. Confirm the target file path and the exact old → new column mappings. If any mapping is ambiguous (e.g. two columns both called `id`), ask exactly once which one they mean.
2. Read the file's header row only.
3. Verify every "old name" exists in the header. If any is missing, stop and list the actual header so the user can correct the mapping.
4. Produce the new header by substituting names positionally; do not reorder columns.
5. Write the output:
   - If the user said "in place", overwrite the original file.
   - Otherwise, write to the path the user specified, or to `<original>.renamed.csv` if unspecified.
6. Report the diff: `old_header → new_header` and the output path.

## Output format

Always return:

```
Renamed <N> column(s) in <path>:
  <old_1> → <new_1>
  <old_2> → <new_2>
  ...
Output: <output_path>
```

## Failure handling

- Missing old column name → stop, print actual header, ask for correction.
- File not found → stop, ask for the correct path.
- File is `.xlsx` or has no header row → decline with one-line reason.
- Ambiguous duplicate header → ask which occurrence to rename.

## Safety

- Never modify cell data.
- Never reorder columns.
- When overwriting in place, keep a `.bak` copy next to the original.
