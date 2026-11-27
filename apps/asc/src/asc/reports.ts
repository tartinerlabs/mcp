import { gunzipSync } from "node:zlib";
import { UnexpectedResponseError } from "../utils/errors.ts";

/** One report file's rows, keyed by its header's column names. */
export interface ReportTable {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * The text of a downloaded report. Apple sends sales, finance and analytics
 * reports gzipped; a body that is not gzip (already decompressed) is read as is.
 */
export function reportText(bytes: Uint8Array): string {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let raw: Uint8Array = bytes;
  if (gzipped) {
    try {
      raw = gunzipSync(bytes);
    } catch {
      throw new UnexpectedResponseError(
        "App Store Connect returned a report that could not be decompressed.",
      );
    }
  }
  return new TextDecoder().decode(raw);
}

/** Splits one comma-separated line, honouring double quotes. */
function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Parses a tab-separated report (or comma-separated, judged by the header).
 * The header is the first line with at least three columns; blank lines,
 * repeated headers and the `Total_…` lines that end a finance report are
 * skipped, and a short row's missing columns read as "".
 */
export function parseReport(text: string): ReportTable {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let split: (line: string) => string[] = (line) => line.split("\t");
  let columns: string[] | undefined;
  let headerLine = "";
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!columns) {
      const tabbed = line.split("\t");
      const fields = tabbed.length >= 3 ? tabbed : splitCsv(line);
      if (fields.length < 3) continue;
      if (fields === tabbed) split = (value) => value.split("\t");
      else split = splitCsv;
      columns = fields.map((name) => name.trim());
      headerLine = line;
      continue;
    }
    if (line === headerLine) continue;
    const fields = split(line);
    if (/^Total_/i.test(fields[0] ?? "")) continue;
    const row: Record<string, string> = {};
    columns.forEach((name, index) => {
      row[name] = (fields[index] ?? "").trim();
    });
    rows.push(row);
  }
  return { columns: columns ?? [], rows };
}

/** Joins tables from several files of one report, such as analytics segments. */
export function mergeReports(tables: ReportTable[]): ReportTable {
  const columns: string[] = [];
  for (const table of tables) {
    for (const name of table.columns) {
      if (!columns.includes(name)) columns.push(name);
    }
  }
  return { columns, rows: tables.flatMap((table) => table.rows) };
}

/** The first of the named columns the row has, ignoring case; Apple's reports vary the capitalisation. */
export function column(
  row: Record<string, string>,
  ...names: string[]
): string {
  for (const name of names) {
    if (name in row) return row[name] ?? "";
    const match = Object.keys(row).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (match) return row[match] ?? "";
  }
  return "";
}

/** A report value as a number; empty or unreadable values count as 0. */
export function toNumber(value: string): number {
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

/** Rounds away floating-point noise from summed money and counts. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
