/** A named table of results, the shape every CSV and XLSX export is written from. */

export interface Table {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  /** One line explaining what a row means, written into the XLSX information sheet. */
  readonly description: string;
}

/** Fail before writing a CSV/XLSX whose values would sit under the wrong headers. */
export function validateTableShape(table: Table): void {
  if (table.columns.length === 0) throw new Error(`${table.name} has no columns.`);
  for (let index = 0; index < table.rows.length; index++) {
    const cells = table.rows[index]!.length;
    if (cells !== table.columns.length) {
      throw new Error(
        `${table.name} row ${index + 1} has ${cells} cells for ${table.columns.length} columns.`,
      );
    }
  }
}
