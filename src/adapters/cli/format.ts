/**
 * Terminal output. Plain aligned text on purpose — a table framework would be
 * a dependency earning nothing, and this output is meant to be readable in a
 * plain SSH session and pipeable into other tools.
 */

export interface TableOptions {
  /** Columns to right-align, by index. Numbers read better on the right. */
  readonly numeric?: readonly number[];
  readonly indent?: string;
}

export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string {
  const indent = options.indent ?? '';
  const numeric = new Set(options.numeric ?? []);
  const all = [header, ...rows];

  const widths: number[] = [];
  for (const row of all) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }

  const render = (row: readonly string[]): string =>
    indent +
    row
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        return numeric.has(index) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      // Trailing padding is invisible but shows up in diffs and pipes.
      .trimEnd();

  const divider = indent + widths.map((width) => '-'.repeat(width)).join('  ');

  return [render(header), divider, ...rows.map(render)].join('\n');
}

export function keyValue(pairs: readonly (readonly [string, string])[], indent = ''): string {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => `${indent}${key.padEnd(width)}  ${value}`).join('\n');
}

/** Fixed-width so a list of dates lines up without a locale surprise. */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isoMinute(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * RFC 4180 quoting. Project and trait names come from an operator and can
 * contain commas, quotes and newlines; unquoted output would silently corrupt
 * a holder list that somebody then imports somewhere else.
 */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}
