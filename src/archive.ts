// The raw archive (CMP-3): every Reporting CSV is kept gzipped, as the source of truth, at
// reports/<type>/<YYYYMMDD of the Pacific day>_<createTime>_<reportId>.csv.gz, with one row per file in report_files.
// v0 parses nothing; v1 reads these files into tables and can always re-read them (`reimport`).

import path from 'node:path';
import zlib from 'node:zlib';
import type { ProfileSession } from './profile.ts';
import type { GoogleApi, Report } from './google/api.ts';
import { csvShape } from './util/csv.ts';
import { sha256Hex, writeFileAtomic } from './util/fsx.ts';
import { pacificDay } from './util/pacific.ts';

const REPORT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TYPE_ID_RE = /^[a-z0-9_]{1,100}$/;

function compactTime(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad timestamp: ${isoTime}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function archivePath(reportTypeId: string, report: Pick<Report, 'id' | 'startTime' | 'createTime'>): string {
  if (!TYPE_ID_RE.test(reportTypeId)) throw new Error(`Unexpected report type id: ${reportTypeId}`);
  if (!REPORT_ID_RE.test(report.id)) throw new Error(`Unexpected report id: ${report.id}`);
  const day = pacificDay(new Date(report.startTime)).replace(/-/g, '');
  return path.join('reports', reportTypeId, `${day}_${compactTime(report.createTime)}_${report.id}.csv.gz`);
}

/** Downloads one report into the archive and records it. Returns false when it was already there. */
export async function archiveReport(s: ProfileSession, api: GoogleApi, reportTypeId: string, report: Report): Promise<boolean> {
  const exists = s.db.prepare('SELECT 1 FROM report_files WHERE report_id = ?').get(report.id);
  if (exists) return false;
  const rel = archivePath(reportTypeId, report);
  const { body, host } = await api.download(report.downloadUrl);
  // fetch decompresses a gzip transfer; a file served as raw gzip is decompressed here.
  const csv = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body, { maxOutputLength: 256 * 1024 * 1024 }) : body;
  const shape = csvShape(csv.toString('utf8'));
  const gz = zlib.gzipSync(csv, { level: 9 });
  writeFileAtomic(path.join(s.pp.dir, rel), gz, 0o600);
  s.db
    .prepare(
      `INSERT INTO report_files (report_id, job_id, report_type_id, start_time, end_time, create_time, report_day_pt,
        job_expire_time, download_host, path, sha256, bytes, bytes_gz, rows, header, downloaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.id,
      report.jobId,
      reportTypeId,
      report.startTime,
      report.endTime,
      report.createTime,
      pacificDay(new Date(report.startTime)),
      report.jobExpireTime ?? null,
      host,
      rel,
      sha256Hex(csv),
      csv.byteLength,
      gz.byteLength,
      shape.rows,
      shape.header.join(','),
      s.ctx.clock.now().toISOString(),
    );
  return true;
}

/** Marks older files of the same type and period as superseded by the newest createTime (a restatement, API-8). */
export function markSuperseded(s: ProfileSession): number {
  const groups = s.db
    .prepare(
      `SELECT report_type_id, start_time, end_time FROM report_files
       GROUP BY report_type_id, start_time, end_time HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ report_type_id: string; start_time: string; end_time: string }>;
  let n = 0;
  for (const g of groups) {
    const files = s.db
      .prepare(
        `SELECT report_id, create_time FROM report_files WHERE report_type_id = ? AND start_time = ? AND end_time = ?
         ORDER BY create_time DESC, report_id DESC`,
      )
      .all(g.report_type_id, g.start_time, g.end_time) as Array<{ report_id: string }>;
    const newest = files[0]!.report_id;
    for (const f of files.slice(1)) {
      n += Number(
        s.db
          .prepare('UPDATE report_files SET superseded_by = ? WHERE report_id = ? AND (superseded_by IS NULL OR superseded_by != ?)')
          .run(newest, f.report_id, newest).changes,
      );
    }
    s.db.prepare('UPDATE report_files SET superseded_by = NULL WHERE report_id = ?').run(newest);
  }
  return n;
}
