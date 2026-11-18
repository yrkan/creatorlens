// v0 keeps Reporting CSVs raw (the archive is the source of truth, CMP-3); it only reads the header and counts rows,
// so a quoted field with a comma or a newline (a search term) is handled as RFC 4180 says.

export interface CsvShape {
  header: string[];
  rows: number;
}

/** Reads the header and counts data rows of a CSV, honouring quotes. A header-only file has 0 rows. */
export function csvShape(text: string): CsvShape {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const header: string[] = [];
  let field = '';
  let inQuotes = false;
  let lineFields = 0;
  let lineHasContent = false;
  let records = 0;
  let headerDone = false;

  const endField = (): void => {
    if (!headerDone) header.push(field);
    field = '';
    lineFields++;
  };
  const endRecord = (): void => {
    if (lineHasContent || lineFields > 0) {
      if (!headerDone) headerDone = true;
      else records++;
    }
    lineFields = 0;
    lineHasContent = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      lineHasContent = true;
    } else if (c === ',') {
      lineHasContent = true;
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (lineHasContent || field.length > 0) endField();
      endRecord();
    } else {
      field += c;
      lineHasContent = true;
    }
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted field');
  if (lineHasContent || field.length > 0) {
    endField();
    endRecord();
  }
  return { header, rows: records };
}
