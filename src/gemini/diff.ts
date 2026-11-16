// A file's old and new text as the unified diff the App shows for a file change. Pure.

const lines = (text: string): string[] => text === "" ? [] : text.replace(/\n$/u, "").split("\n");

/** Past this many line pairs the changed middle is shown replaced whole (the table of a line diff grows with it). */
const LCS_CELLS = 4_000_000;

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** The lines both keep, as an edit script over the two (longest common subsequence). */
function editScript(before: readonly string[], after: readonly string[]): Op[] {
  if (before.length * after.length > LCS_CELLS) {
    return [...before.map((line) => ({ kind: "-" as const, line })), ...after.map((line) => ({ kind: "+" as const, line }))];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { ops.push({ kind: " ", line: before[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { ops.push({ kind: "-", line: before[i]! }); i += 1; }
    else { ops.push({ kind: "+", line: after[j]! }); j += 1; }
  }
  for (; i < before.length; i += 1) ops.push({ kind: "-", line: before[i]! });
  for (; j < after.length; j += 1) ops.push({ kind: "+", line: after[j]! });
  return ops;
}

/** Unified hunks (`@@ -a,b +c,d @@`, no file header) turning `before` into `after`; "" when they are the same. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const old = lines(before);
  const now = lines(after);
  // Most edits touch a few lines of a long file: only what lies between the common ends is compared.
  let head = 0;
  while (head < old.length && head < now.length && old[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < now.length - head && old[old.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  const ops: Op[] = [
    ...old.slice(0, head).map((line) => ({ kind: " " as const, line })),
    ...editScript(old.slice(head, old.length - tail), now.slice(head, now.length - tail)),
    ...old.slice(old.length - tail).map((line) => ({ kind: " " as const, line })),
  ];
  const changed = ops.flatMap((op, index) => op.kind === " " ? [] : [index]);
  if (!changed.length) return "";
  // Changes closer than two contexts share a hunk.
  const spans: Array<{ from: number; to: number }> = [];
  for (const index of changed) {
    const last = spans.at(-1);
    if (last && index - last.to <= 2 * context) last.to = index;
    else spans.push({ from: index, to: index });
  }
  return spans.map(({ from, to }) => {
    const start = Math.max(0, from - context);
    const end = Math.min(ops.length, to + context + 1);
    const before = ops.slice(0, start);
    const oldStart = before.filter((op) => op.kind !== "+").length;
    const newStart = before.filter((op) => op.kind !== "-").length;
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    return [`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@`, ...hunk.map((op) => `${op.kind}${op.line}`)].join("\n");
  }).join("\n");
}
