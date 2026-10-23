/**
 * Safely merges the supplied G2/G1/G6/G3 CSV exports into the ERP schema.
 * Uses PostgreSQL COPY into temporary text staging tables, then set-based inserts.
 * Existing rows are never truncated or overwritten.
 *
 * Usage: npx tsx scripts/db/load-group3.ts
 */
import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { withClient } from './client.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(ROOT, 'data');
const inserted = new Map<string, number>();
const sourceCounts = new Map<string, number>();
const fkFailures = new Map<string, number>();
const dataFailures = new Map<string, number>();
const TARGET_TABLES = [
  'department', 'program', 'course', 'course_prerequisite', 'academic_session', 'program_curriculum',
  'student', 'faculty', 'division', 'batch', 'student_section', 'teaching_assignment',
  'attendance_session', 'attendance_summary', 'grade_scale', 'course_exam_scheme', 'exam_cycle',
  'exam_schedule', 'exam_registration', 'hall_ticket', 'exam_marks', 'course_result',
  'semester_result', 'student_cgpa',
];

interface Stage {
  table: string;
  columns: string[];
  rows: number;
}

const stages = new Map<string, Stage>();
const qid = (value: string): string => `"${value.replace(/"/g, '""')}"`;

function c(stage: string, column: string, alias = 's'): string {
  const info = stages.get(stage);
  if (!info) throw new Error(`Missing staged CSV ${stage}`);
  const index = info.columns.indexOf(column);
  if (index < 0) throw new Error(`${stage} is missing required column ${column}`);
  return `${alias}.${qid(`c${index + 1}`)}`;
}

function addCount(target: Map<string, number>, key: string, count: number): void {
  if (count > 0) target.set(key, (target.get(key) ?? 0) + count);
}

async function stageCsv(db: import('pg').Client, key: string, file: string): Promise<Stage> {
  const fh = await open(file, 'r');
  let header: string;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(16_384), 0, 16_384, 0);
    header = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  } finally {
    await fh.close();
  }
  const columns = header.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
  if (!header || columns.some((column) => !column)) throw new Error(`Invalid CSV header in ${file}`);
  const table = `stage_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  await db.query(`CREATE TEMP TABLE ${qid(table)} (${columns.map((_, i) => `${qid(`c${i + 1}`)} text`).join(', ')})`);
  const result = db.query(copyFrom(
    `COPY ${qid(table)} FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`,
  ));
  if (key === 'core_students') {
    const decoder = new TextDecoder('windows-1252');
    const transcode = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, decoder.decode(chunk, { stream: true }));
      },
      flush(callback) {
        callback(null, decoder.decode());
      },
    });
    await pipeline(createReadStream(file), transcode, result);
  } else {
    await pipeline(createReadStream(file), result);
  }
  const stage = { table, columns, rows: result.rowCount ?? 0 };
  stages.set(key, stage);
  sourceCounts.set(key, stage.rows);
  return stage;
}

async function stageDirectory(db: import('pg').Client, dir: string, select: (name: string) => boolean): Promise<string[]> {
  const names = (await readdir(dir)).filter(select).sort();
  const keys: string[] = [];
  for (const name of names) {
    const key = `${path.basename(dir)}_${name.replace(/\.csv$/i, '')}`;
    await stageCsv(db, key, path.join(dir, name));
    keys.push(key);
  }
  return keys;
}

async function addFKFailure(db: import('pg').Client, table: string, cause: string, sql: string): Promise<void> {
  let result;
  try {
    result = await db.query<{ count: string }>(sql);
  } catch (error) {
    throw new Error(`FK preflight ${table} (${cause}) failed: ${error instanceof Error ? error.message : error}`);
  }
  addCount(fkFailures, `${table}: ${cause}`, Number(result.rows[0]?.count ?? 0));
}

async function addDataFailure(db: import('pg').Client, table: string, cause: string, sql: string): Promise<void> {
  let result;
  try {
    result = await db.query<{ count: string }>(sql);
  } catch (error) {
    throw new Error(`Data preflight ${table} (${cause}) failed: ${error instanceof Error ? error.message : error}`);
  }
  addCount(dataFailures, `${table}: ${cause}`, Number(result.rows[0]?.count ?? 0));
}

async function merge(db: import('pg').Client, table: string, sql: string): Promise<void> {
  let result;
  try {
    result = await db.query(sql);
  } catch (error) {
    throw new Error(`Merge ${table} failed: ${error instanceof Error ? error.message : error}`);
  }
  addCount(inserted, table, result.rowCount ?? 0);
}

async function tableCount(db: import('pg').Client, table: string): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM erp.${qid(table)}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function importAcademic(db: import('pg').Client): Promise<void> {
  const dir = path.join(SOURCE, 'academic');
  await stageDirectory(db, dir, (name) => /^0[1-7]_.*\.csv$/i.test(name));

  const d = 'academic_01_DEPARTMENT';
  await addFKFailure(db, 'department', 'department reference is malformed', `
    SELECT count(*) FROM ${qid(stages.get(d)!.table)} s
    WHERE nullif(trim(${c(d, 'dept_id')}), '') IS NULL OR nullif(trim(${c(d, 'dept_name')}), '') IS NULL`);
  await merge(db, 'department', `
    INSERT INTO erp.department (dept_id, dept_name, office_room, contact_email, established_year, is_active)
    SELECT ${c(d, 'dept_id')}, ${c(d, 'dept_name')}, nullif(${c(d, 'office_room')}, ''),
           nullif(${c(d, 'contact_email')}, ''), nullif(${c(d, 'established_year')}, '')::smallint,
           coalesce(nullif(${c(d, 'is_active')}, '')::int, 1) <> 0
    FROM ${qid(stages.get(d)!.table)} s
    WHERE nullif(trim(${c(d, 'dept_id')}), '') IS NOT NULL
      AND nullif(trim(${c(d, 'dept_name')}), '') IS NOT NULL
    ON CONFLICT DO NOTHING`);

  const p = 'academic_02_PROGRAM';
  await addFKFailure(db, 'program', 'missing department', `
    SELECT count(*) FROM ${qid(stages.get(p)!.table)} s
    LEFT JOIN erp.department d ON d.dept_id = ${c(p, 'dept_id')}
    WHERE d.dept_id IS NULL`);
  await merge(db, 'program', `
    INSERT INTO erp.program (program_id, dept_id, program_name, degree_level, duration_years,
                             total_semesters, total_credits_req, intake_capacity, is_active)
    SELECT s.${qid('c1')}, s.${qid('c2')}, s.${qid('c3')}, s.${qid('c4')}::erp.degree_level,
           s.${qid('c5')}::smallint, s.${qid('c6')}::smallint, s.${qid('c7')}::numeric,
           s.${qid('c8')}::smallint, coalesce(nullif(s.${qid('c9')}, '')::int, 1) <> 0
    FROM ${qid(stages.get(p)!.table)} s
    JOIN erp.department d ON d.dept_id = s.${qid('c2')}
    ON CONFLICT DO NOTHING`);

  const co = 'academic_03_COURSE';
  await addFKFailure(db, 'course', 'missing department', `
    SELECT count(*) FROM ${qid(stages.get(co)!.table)} s
    LEFT JOIN erp.department d ON d.dept_id = ${c(co, 'dept_id')}
    WHERE d.dept_id IS NULL`);
  await merge(db, 'course', `
    INSERT INTO erp.course (course_id, course_code, course_name, dept_id, credits, course_type,
                            lecture_hrs, tutorial_hrs, practical_hrs, syllabus_version,
                            min_attendance_pct, is_active)
    SELECT ${c(co, 'course_id')}::int, ${c(co, 'course_code')}, ${c(co, 'course_name')},
           ${c(co, 'dept_id')}, ${c(co, 'credits')}::numeric, ${c(co, 'course_type')}::erp.course_type,
           split_part(${c(co, 'l_t_p')}, '-', 1)::smallint,
           split_part(${c(co, 'l_t_p')}, '-', 2)::smallint,
           split_part(${c(co, 'l_t_p')}, '-', 3)::smallint,
           ${c(co, 'syllabus_version')}, 75,
           coalesce(nullif(${c(co, 'is_active')}, '')::int, 1) <> 0
    FROM ${qid(stages.get(co)!.table)} s
    JOIN erp.department d ON d.dept_id = ${c(co, 'dept_id')}
    ON CONFLICT DO NOTHING`);

  const pr = 'academic_04_COURSE_PREREQUISITE';
  await addFKFailure(db, 'course_prerequisite', 'missing course or prerequisite', `
    SELECT count(*) FROM ${qid(stages.get(pr)!.table)} s
    LEFT JOIN erp.course a ON a.course_id = ${c(pr, 'course_id')}::int
    LEFT JOIN erp.course b ON b.course_id = ${c(pr, 'prereq_course_id')}::int
    WHERE a.course_id IS NULL OR b.course_id IS NULL`);
  await merge(db, 'course_prerequisite', `
    INSERT INTO erp.course_prerequisite (course_id, prereq_course_id, min_grade)
    SELECT ${c(pr, 'course_id')}::int, ${c(pr, 'prereq_course_id')}::int,
           coalesce(nullif(${c(pr, 'min_grade')}, ''), 'P')
    FROM ${qid(stages.get(pr)!.table)} s
    JOIN erp.course a ON a.course_id = ${c(pr, 'course_id')}::int
    JOIN erp.course b ON b.course_id = ${c(pr, 'prereq_course_id')}::int
    ON CONFLICT DO NOTHING`);

  const se = 'academic_05_ACADEMIC_SESSION';
  await merge(db, 'academic_session', `
    INSERT INTO erp.academic_session
      (session_id, session_name, academic_year, term_type, start_date, end_date, is_current)
    SELECT ${c(se, 'session_id')}, ${c(se, 'session_name')}, ${c(se, 'academic_year')},
           ${c(se, 'term_type')}::erp.term_type,
           pg_temp.erp_loader_date(${c(se, 'start_date')}), pg_temp.erp_loader_date(${c(se, 'end_date')}),
           coalesce(nullif(${c(se, 'is_current')}, '')::int, 0) <> 0
    FROM ${qid(stages.get(se)!.table)} s
    ON CONFLICT DO NOTHING`);

  const cu = 'academic_06_PROGRAM_CURRICULUM';
  await addFKFailure(db, 'program_curriculum', 'missing program or course', `
    SELECT count(*) FROM ${qid(stages.get(cu)!.table)} s
    LEFT JOIN erp.program p ON p.program_id = ${c(cu, 'program_id')}
    LEFT JOIN erp.course c ON c.course_id = ${c(cu, 'course_id')}::int
    WHERE p.program_id IS NULL OR c.course_id IS NULL`);
  await merge(db, 'program_curriculum', `
    INSERT INTO erp.program_curriculum (program_id, course_id, semester_no, course_category, elective_group)
    SELECT ${c(cu, 'program_id')}, ${c(cu, 'course_id')}::int, ${c(cu, 'semester_no')}::smallint,
           ${c(cu, 'course_category')}::erp.course_category, nullif(${c(cu, 'elective_group')}, '')
    FROM ${qid(stages.get(cu)!.table)} s
    JOIN erp.program p ON p.program_id = ${c(cu, 'program_id')}
    JOIN erp.course co ON co.course_id = ${c(cu, 'course_id')}::int
    ON CONFLICT DO NOTHING`);

  const offering = 'academic_07_COURSE_OFFERING_demo_sections';
  const offeringStage = stages.get(offering);
  if (offeringStage) {
    addCount(dataFailures, 'course_offering: G2 demo section not imported; generated offerings are already in use',
      offeringStage.rows);
  }
  await addDataFailure(db, 'department', 'HOD employee code has no verified portal faculty match', `
    SELECT count(*) FROM ${qid(stages.get(d)!.table)} s
    WHERE nullif(${c(d, 'hod_faculty_id')}, '') IS NOT NULL`);
}

async function importCore(db: import('pg').Client): Promise<void> {
  const dir = path.join(SOURCE, 'core');
  await stageCsv(db, 'core_students', path.join(dir, 'students.csv'));
  await stageDirectory(db, dir, (name) => /^faculty_.*\.csv$/i.test(name));

  const st = 'core_students';
  await addFKFailure(db, 'student', 'missing department/program', `
    SELECT count(*) FROM ${qid(stages.get(st)!.table)} s
    LEFT JOIN erp.department d ON d.dept_id = ${c(st, 'dept_id')}
    LEFT JOIN erp.program p ON p.program_id = 'BTECH-' || ${c(st, 'dept_id')}
    WHERE d.dept_id IS NULL OR p.program_id IS NULL`);
  await addDataFailure(db, 'student', 'DOB is less than 15 years before admission', `
    SELECT count(*) FROM ${qid(stages.get(st)!.table)} s
    WHERE pg_temp.erp_loader_date(${c(st, 'date_of_birth')}) >= pg_temp.erp_loader_date(${c(st, 'admission_date')}) - interval '15 years'`);
  await addDataFailure(db, 'student', 'admission year differs from admission-number year', `
    SELECT count(*) FROM ${qid(stages.get(st)!.table)} s
    WHERE ${c(st, 'admission_number')} ~ '^ADM[0-9]{4}'
      AND extract(year FROM pg_temp.erp_loader_date(${c(st, 'admission_date')})) <>
          substring(${c(st, 'admission_number')} from 4 for 4)::int`);
  await addDataFailure(db, 'student', 'invalid contact number', `
    SELECT count(*) FROM ${qid(stages.get(st)!.table)} s
    WHERE ${c(st, 'mobile_number')} !~ '^[6-9][0-9]{9}$'
       OR (nullif(${c(st, 'alternate_mobile')}, '') IS NOT NULL
           AND ${c(st, 'alternate_mobile')} !~ '^[6-9][0-9]{9}$')`);

  await db.query('LOCK TABLE erp.student IN SHARE ROW EXCLUSIVE MODE');
  await merge(db, 'student', `
    WITH valid AS (
      SELECT s.*, 'BTECH-' || ${c(st, 'dept_id')} AS mapped_program,
             substring(${c(st, 'admission_number')} from 4 for 4)::smallint AS adm_year,
             pg_temp.erp_loader_date(${c(st, 'date_of_birth')}) AS dob,
             pg_temp.erp_loader_date(${c(st, 'admission_date')}) AS adm_date
      FROM ${qid(stages.get(st)!.table)} s
      JOIN erp.department d ON d.dept_id = ${c(st, 'dept_id')}
      JOIN erp.program p ON p.program_id = 'BTECH-' || ${c(st, 'dept_id')}
      WHERE ${c(st, 'mobile_number')} ~ '^[6-9][0-9]{9}$'
        AND (nullif(${c(st, 'alternate_mobile')}, '') IS NULL OR ${c(st, 'alternate_mobile')} ~ '^[6-9][0-9]{9}$')
        AND pg_temp.erp_loader_date(${c(st, 'date_of_birth')}) < pg_temp.erp_loader_date(${c(st, 'admission_date')}) - interval '15 years'
        AND ${c(st, 'admission_number')} ~ '^ADM[0-9]{4}'
        AND extract(year FROM pg_temp.erp_loader_date(${c(st, 'admission_date')})) =
            substring(${c(st, 'admission_number')} from 4 for 4)::int
        AND NOT EXISTS (SELECT 1 FROM erp.student old WHERE old.student_number = ${c(st, 'student_number')})
    ), numbered AS (
      SELECT valid.*, (SELECT coalesce(max(student_id), 0) FROM erp.student)
                         + row_number() OVER (ORDER BY ${c(st, 'student_number', 'valid')})::int AS new_id
      FROM valid
    )
    INSERT INTO erp.student
      (student_id, student_number, first_name, middle_name, last_name, date_of_birth, gender,
       blood_group, email, personal_email, mobile_number, alternate_mobile, category, nationality,
       status, admission_number, admission_date, admission_type, admission_year, program_id,
       district_name, address, pincode)
    SELECT new_id, ${c(st, 'student_number')}, ${c(st, 'first_name')}, nullif(${c(st, 'middle_name')}, ''),
       ${c(st, 'last_name')}, dob, ${c(st, 'gender')}::erp.gender_type, nullif(${c(st, 'blood_group')}, ''),
       ${c(st, 'email')}, nullif(${c(st, 'personal_email')}, ''), ${c(st, 'mobile_number')},
       nullif(${c(st, 'alternate_mobile')}, ''), ${c(st, 'category')}::erp.social_category,
       coalesce(nullif(${c(st, 'nationality')}, ''), 'Indian'),
       ${c(st, 'status')}::erp.student_status, ${c(st, 'admission_number')}, adm_date,
       ${c(st, 'admission_type')}::erp.admission_type, adm_year, mapped_program,
       nullif(${c(st, 'district_name')}, ''), nullif(${c(st, 'address')}, ''),
       nullif(${c(st, 'pincode')}, '')
    FROM numbered s
    ON CONFLICT DO NOTHING`);

  const facultyKey = 'core_faculty_faculty';
  const facultyFile = stages.get(facultyKey);
  if (facultyFile) {
    await addDataFailure(db, 'faculty', 'required gender missing from source CSV', `
      SELECT count(*) FROM ${qid(facultyFile.table)}`);
    await db.query(`CREATE TEMP TABLE source_faculty_id_map (source_id int PRIMARY KEY, faculty_id int)`);
    await db.query(`
      INSERT INTO source_faculty_id_map (source_id, faculty_id)
      SELECT ${c(facultyKey, 'Faculty_ID')}::int, f.faculty_id
      FROM ${qid(facultyFile.table)} s
      JOIN erp.faculty f ON lower(f.email) = lower(${c(facultyKey, 'Email')})
         OR f.faculty_code = ${c(facultyKey, 'Employee_Code')}
      ON CONFLICT (source_id) DO UPDATE SET faculty_id = EXCLUDED.faculty_id`);
    await addFKFailure(db, 'faculty', 'department code not found', `
      SELECT count(*) FROM ${qid(facultyFile.table)} s
      LEFT JOIN erp.department d ON d.dept_id = ${c(facultyKey, 'Department_ID')}
      WHERE d.dept_id IS NULL`);
    await addFKFailure(db, 'faculty', 'designation lookup missing', `
      SELECT count(*) FROM ${qid(facultyFile.table)} s
      LEFT JOIN ${qid(stages.get('core_faculty_designations')!.table)} des
        ON des.${qid(`c${stages.get('core_faculty_designations')!.columns.indexOf('Designation_ID') + 1}`)}
         = ${c(facultyKey, 'Designation_ID')}
      WHERE des.${qid(`c${stages.get('core_faculty_designations')!.columns.indexOf('Designation_Name') + 1}`)} IS NULL`);
    await addFKFailure(db, 'faculty', 'employee code/email cannot be mapped to an existing portal faculty row', `
      SELECT count(*) FROM ${qid(facultyFile.table)} s
      LEFT JOIN erp.faculty f ON lower(f.email) = lower(${c(facultyKey, 'Email')})
         OR f.faculty_code = ${c(facultyKey, 'Employee_Code')}
      WHERE f.faculty_id IS NULL`);
  }
}

async function importAttendance(db: import('pg').Client): Promise<void> {
  const dir = path.join(SOURCE, 'attendance');
  const keys = await stageDirectory(db, dir, (name) => /\.csv$/i.test(name));
  const byFile = (prefix: string): string | undefined => keys.find((key) => key.endsWith(prefix));
  const divisions = byFile('attendance_divisions');
  const batches = byFile('attendance_batches');
  const mapping = byFile('student_section_mapping');
  const assignments = byFile('teaching_assignments');

  if (divisions) {
    await addFKFailure(db, 'division', 'department missing', `
      SELECT count(*) FROM ${qid(stages.get(divisions)!.table)} s
      LEFT JOIN erp.department d ON d.dept_id = ${c(divisions, 'department_id')}
      WHERE d.dept_id IS NULL`);
    await merge(db, 'division', `
      INSERT INTO erp.division (division_code, dept_id, academic_session_id, year_of_study, semester)
      SELECT ${c(divisions, 'division_code')}, ${c(divisions, 'department_id')}, ses.session_id,
             ${c(divisions, 'year_of_study')}::smallint, ${c(divisions, 'semester')}::smallint
      FROM ${qid(stages.get(divisions)!.table)} s
      JOIN erp.department d ON d.dept_id = ${c(divisions, 'department_id')}
      JOIN erp.academic_session ses ON ses.academic_year = ${c(divisions, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(divisions, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      ON CONFLICT DO NOTHING`);
  }
  if (batches && divisions) {
    await addFKFailure(db, 'batch', 'division missing', `
      SELECT count(*) FROM ${qid(stages.get(batches)!.table)} s
      LEFT JOIN ${qid(stages.get(divisions)!.table)} src ON ${c(divisions, 'division_id', 'src')}::int = ${c(batches, 'division_id')}::int
      LEFT JOIN erp.division d ON d.division_code = ${c(divisions, 'division_code', 'src')}
      WHERE src.${qid('c1')} IS NULL OR d.division_id IS NULL`);
    await merge(db, 'batch', `
      INSERT INTO erp.batch (batch_code, division_id, batch_no)
      SELECT ${c(batches, 'batch_code')}, d.division_id,
             substring(${c(batches, 'batch_code')} from '-B([0-9]+)$')::smallint
      FROM ${qid(stages.get(batches)!.table)} s
      JOIN ${qid(stages.get(divisions)!.table)} src
        ON ${c(divisions, 'division_id', 'src')}::int = ${c(batches, 'division_id')}::int
      JOIN erp.division d ON d.division_code = ${c(divisions, 'division_code', 'src')}
      WHERE ${c(batches, 'batch_code')} ~ '-B[0-9]+$'
      ON CONFLICT DO NOTHING`);
  }
  if (mapping && divisions && batches) {
    await addFKFailure(db, 'student_section', 'student number missing', `
      SELECT count(*) FROM ${qid(stages.get(mapping)!.table)} s
      LEFT JOIN erp.student st ON st.student_number = ${c(mapping, 'student_number')}
      WHERE st.student_id IS NULL`);
    await addFKFailure(db, 'student_section', 'division/batch/session missing', `
      SELECT count(*) FROM ${qid(stages.get(mapping)!.table)} s
      LEFT JOIN ${qid(stages.get(divisions)!.table)} sd ON ${c(divisions, 'division_id', 'sd')}::int = ${c(mapping, 'division_id')}::int
      LEFT JOIN erp.division d ON d.division_code = ${c(divisions, 'division_code', 'sd')}
      LEFT JOIN ${qid(stages.get(batches)!.table)} sb ON ${c(batches, 'batch_id', 'sb')}::int = ${c(mapping, 'batch_id')}::int
      LEFT JOIN erp.batch b ON b.batch_code = ${c(batches, 'batch_code', 'sb')}
      LEFT JOIN erp.academic_session ses ON ses.academic_year = ${c(mapping, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(mapping, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      WHERE sd.${qid('c1')} IS NULL OR d.division_id IS NULL OR sb.${qid('c1')} IS NULL OR b.batch_id IS NULL OR ses.session_id IS NULL`);
    await merge(db, 'student_section', `
      INSERT INTO erp.student_section (student_id, academic_session_id, division_id, batch_id, roll_no)
      SELECT st.student_id, ses.session_id, d.division_id, b.batch_id, ${c(mapping, 'roll_no')}::smallint
      FROM ${qid(stages.get(mapping)!.table)} s
      JOIN erp.student st ON st.student_number = ${c(mapping, 'student_number')}
      JOIN ${qid(stages.get(divisions)!.table)} sd ON ${c(divisions, 'division_id', 'sd')}::int = ${c(mapping, 'division_id')}::int
      JOIN erp.division d ON d.division_code = ${c(divisions, 'division_code', 'sd')}
      JOIN ${qid(stages.get(batches)!.table)} sb ON ${c(batches, 'batch_id', 'sb')}::int = ${c(mapping, 'batch_id')}::int
      JOIN erp.batch b ON b.batch_code = ${c(batches, 'batch_code', 'sb')}
      JOIN erp.academic_session ses ON ses.academic_year = ${c(mapping, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(mapping, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      ON CONFLICT DO NOTHING`);
  }
  if (assignments) {
    await db.query(`CREATE TEMP TABLE source_assignment_id_map (source_id int PRIMARY KEY, assignment_id int)`);
    await addFKFailure(db, 'teaching_assignment', 'course missing', `
      SELECT count(*) FROM ${qid(stages.get(assignments)!.table)} s
      LEFT JOIN erp.course c ON c.course_id = ${c(assignments, 'course_id')}::int
      WHERE c.course_id IS NULL`);
    await addFKFailure(db, 'teaching_assignment', 'faculty source id cannot be mapped', `
      SELECT count(*) FROM ${qid(stages.get(assignments)!.table)} s
      LEFT JOIN source_faculty_id_map f ON f.source_id = ${c(assignments, 'faculty_id')}::int AND f.faculty_id IS NOT NULL
      WHERE f.faculty_id IS NULL`);
    const sourceDivisions = byFile('attendance_divisions');
    const sourceBatches = byFile('attendance_batches');
    if (!sourceDivisions || !sourceBatches) throw new Error('Attendance division/batch CSV is missing');
    await addFKFailure(db, 'teaching_assignment', 'division/batch/session missing', `
      SELECT count(*) FROM ${qid(stages.get(assignments)!.table)} s
      LEFT JOIN ${qid(stages.get(sourceDivisions)!.table)} sd
        ON ${c(sourceDivisions, 'division_id', 'sd')}::int = ${c(assignments, 'division_id')}::int
      LEFT JOIN erp.division d ON d.division_code = ${c(sourceDivisions, 'division_code', 'sd')}
      LEFT JOIN ${qid(stages.get(sourceBatches)!.table)} sb
        ON ${c(sourceBatches, 'batch_id', 'sb')}::int = nullif(${c(assignments, 'batch_id')}, '')::int
      LEFT JOIN erp.batch b ON b.batch_code = ${c(sourceBatches, 'batch_code', 'sb')}
      LEFT JOIN erp.academic_session ses ON ses.academic_year = ${c(assignments, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(assignments, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      WHERE sd.${qid('c1')} IS NULL OR d.division_id IS NULL OR ses.session_id IS NULL
        OR (nullif(${c(assignments, 'batch_id')}, '') IS NOT NULL
            AND (sb.${qid('c1')} IS NULL OR b.batch_id IS NULL))`);
    await merge(db, 'teaching_assignment', `
      INSERT INTO erp.teaching_assignment
        (academic_session_id, course_id, faculty_id, division_id, batch_id, session_type, weekly_sessions)
      SELECT ses.session_id, co.course_id, fmap.faculty_id, div.division_id, bat.batch_id,
             ${c(assignments, 'session_type')}::erp.session_kind, ${c(assignments, 'weekly_sessions')}::smallint
      FROM ${qid(stages.get(assignments)!.table)} s
      JOIN erp.academic_session ses ON ses.academic_year = ${c(assignments, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(assignments, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      JOIN erp.course co ON co.course_id = ${c(assignments, 'course_id')}::int
      JOIN source_faculty_id_map fmap ON fmap.source_id = ${c(assignments, 'faculty_id')}::int AND fmap.faculty_id IS NOT NULL
      JOIN ${qid(stages.get(sourceDivisions)!.table)} srcdiv
        ON ${c(sourceDivisions, 'division_id', 'srcdiv')}::int = ${c(assignments, 'division_id')}::int
      JOIN erp.division div ON div.division_code = ${c(sourceDivisions, 'division_code', 'srcdiv')}
      LEFT JOIN ${qid(stages.get(sourceBatches)!.table)} srcbat
        ON ${c(sourceBatches, 'batch_id', 'srcbat')}::int = nullif(${c(assignments, 'batch_id')}, '')::int
      LEFT JOIN erp.batch bat ON bat.batch_code = ${c(sourceBatches, 'batch_code', 'srcbat')}
      WHERE ((${c(assignments, 'session_type')} = 'Lab') = (bat.batch_id IS NOT NULL))
      ON CONFLICT DO NOTHING`);
    await db.query(`
      INSERT INTO source_assignment_id_map (source_id, assignment_id)
      SELECT ${c(assignments, 'assignment_id')}::int, ta.assignment_id
      FROM ${qid(stages.get(assignments)!.table)} s
      JOIN erp.academic_session ses ON ses.academic_year = ${c(assignments, 'academic_year')}
        AND ses.term_type = CASE WHEN ${c(assignments, 'semester')}::int % 2 = 1 THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END
      JOIN erp.course co ON co.course_id = ${c(assignments, 'course_id')}::int
      JOIN source_faculty_id_map fmap ON fmap.source_id = ${c(assignments, 'faculty_id')}::int AND fmap.faculty_id IS NOT NULL
      JOIN ${qid(stages.get(sourceDivisions)!.table)} srcdiv
        ON ${c(sourceDivisions, 'division_id', 'srcdiv')}::int = ${c(assignments, 'division_id')}::int
      JOIN erp.division div ON div.division_code = ${c(sourceDivisions, 'division_code', 'srcdiv')}
      LEFT JOIN ${qid(stages.get(sourceBatches)!.table)} srcbat
        ON ${c(sourceBatches, 'batch_id', 'srcbat')}::int = nullif(${c(assignments, 'batch_id')}, '')::int
      LEFT JOIN erp.batch bat ON bat.batch_code = ${c(sourceBatches, 'batch_code', 'srcbat')}
      JOIN erp.teaching_assignment ta ON ta.academic_session_id = ses.session_id AND ta.course_id = co.course_id
        AND ta.faculty_id = fmap.faculty_id AND ta.division_id = div.division_id
        AND ta.batch_id IS NOT DISTINCT FROM bat.batch_id
        AND ta.offering_id IS NULL
      ON CONFLICT (source_id) DO UPDATE SET assignment_id = EXCLUDED.assignment_id`);
  }
  const sessionFile = byFile('attendance_sessions');
  if (sessionFile) {
    await addFKFailure(db, 'attendance_session', 'teaching assignment missing', `
      SELECT count(*) FROM ${qid(stages.get(sessionFile)!.table)} s
      LEFT JOIN source_assignment_id_map a ON a.source_id = ${c(sessionFile, 'assignment_id')}::int
      WHERE a.assignment_id IS NULL`);
    await addFKFailure(db, 'attendance_session', 'marked_by faculty id cannot be mapped', `
      SELECT count(*) FROM ${qid(stages.get(sessionFile)!.table)} s
      LEFT JOIN source_faculty_id_map f ON f.source_id = ${c(sessionFile, 'marked_by')}::int AND f.faculty_id IS NOT NULL
      WHERE f.faculty_id IS NULL`);
    addCount(dataFailures, 'attendance_session: timetable entry not supplied by source; imported as null', sourceCounts.get(sessionFile) ?? 0);
  }
  const recordKeys = keys.filter((key) => key.includes('attendance_records_'));
  if (recordKeys.length) {
    const missingStudentSql = recordKeys.map((key) => `
      SELECT count(*)::bigint AS n FROM ${qid(stages.get(key)!.table)} s
      LEFT JOIN erp.student st ON st.student_number = ${c(key, 'student_number')}
      WHERE st.student_id IS NULL`).join(' UNION ALL ');
    await addFKFailure(db, 'attendance_session', 'attendance record references unknown student', `
      SELECT coalesce(sum(n), 0) FROM (${missingStudentSql}) counts`);
  }
  if (sessionFile && recordKeys.length) {
    const records = recordKeys.map((key) => `
      SELECT ${c(key, 'session_id')}::int AS session_id, st.student_id, ${c(key, 'status')} AS status
      FROM ${qid(stages.get(key)!.table)} s
      JOIN erp.student st ON st.student_number = ${c(key, 'student_number')}`).join(' UNION ALL ');
    const sf = stages.get(sessionFile)!;
    await db.query(`CREATE TEMP VIEW source_attendance_records AS ${records}`);
    await addFKFailure(db, 'attendance_session', 'absent student is not on the assignment roster', `
      WITH absent AS (
        SELECT a.assignment_id, r.student_id FROM ${qid(sf.table)} src
        JOIN source_assignment_id_map a ON a.source_id = ${c(sessionFile, 'assignment_id', 'src')}::int
        JOIN source_attendance_records r ON r.session_id = ${c(sessionFile, 'session_id', 'src')}::int AND r.status = 'A'
      )
      SELECT count(*) FROM absent x
      WHERE NOT EXISTS (SELECT 1 FROM erp.v_assignment_roster vr
                        WHERE vr.assignment_id = x.assignment_id AND vr.student_id = x.student_id)`);
    await merge(db, 'attendance_session', `
      WITH record_set AS (${records}),
      session_data AS (
        SELECT ${c(sessionFile, 'session_id')}::int AS source_session_id,
               amap.assignment_id, pg_temp.erp_loader_date(${c(sessionFile, 'session_date')}) AS session_date,
               ${c(sessionFile, 'session_number')}::smallint AS session_number,
               ${c(sessionFile, 'duration_hrs')}::numeric(3,1) AS duration_hrs,
               ${c(sessionFile, 'session_status')}::erp.session_status AS session_status,
               fmap.faculty_id AS marked_by,
               nullif(${c(sessionFile, 'marked_at')}, '')::timestamptz AS marked_at
        FROM ${qid(sf.table)} s
        JOIN source_assignment_id_map amap ON amap.source_id = ${c(sessionFile, 'assignment_id')}::int
        JOIN source_faculty_id_map fmap ON fmap.source_id = ${c(sessionFile, 'marked_by')}::int AND fmap.faculty_id IS NOT NULL
      ), absent AS (
        SELECT r.session_id, array_agg(DISTINCT r.student_id ORDER BY r.student_id)::int[] AS ids
        FROM record_set r WHERE r.status = 'A' GROUP BY r.session_id
      )
      INSERT INTO erp.attendance_session
        (assignment_id, session_date, session_number, duration_hrs, session_status,
         absent_student_ids, marked_by, marked_at)
      SELECT d.assignment_id, d.session_date, d.session_number, d.duration_hrs, d.session_status,
             CASE WHEN d.session_status = 'Conducted' THEN coalesce(a.ids, '{}'::int[]) ELSE '{}'::int[] END,
             d.marked_by, d.marked_at
      FROM session_data d
      LEFT JOIN absent a ON a.session_id = d.source_session_id
      WHERE (d.session_status = 'Cancelled' OR d.marked_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM erp.attendance_session old
                        WHERE old.assignment_id = d.assignment_id AND old.session_date = d.session_date)
        AND NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(a.ids, '{}'::int[])) ids(student_id)
          WHERE NOT EXISTS (SELECT 1 FROM erp.v_assignment_roster vr
                            WHERE vr.assignment_id = d.assignment_id AND vr.student_id = ids.student_id))
      ON CONFLICT DO NOTHING`);
  }
  if (byFile('course_attendance_config')) {
    addCount(dataFailures, 'course attendance config: validated against existing course; no duplicate table created',
      sourceCounts.get(byFile('course_attendance_config')!) ?? 0);
  }
  if (byFile('attendance_summary')) {
    addCount(dataFailures, 'attendance_summary: source totals are derived in the portal; refreshed by attendance triggers',
      sourceCounts.get(byFile('attendance_summary')!) ?? 0);
  }
}

async function importExamination(db: import('pg').Client): Promise<void> {
  const dir = path.join(SOURCE, 'examination');
  await stageDirectory(db, dir, (name) => /\.csv$/i.test(name));

  const gs = 'examination_grade_scale';
  await merge(db, 'grade_scale', `
    INSERT INTO erp.grade_scale (grade, min_percentage, max_percentage, grade_points, description)
    SELECT ${c(gs, 'grade')}, ${c(gs, 'min_percentage')}::numeric, ${c(gs, 'max_percentage')}::numeric,
           ${c(gs, 'grade_points')}::smallint, ${c(gs, 'description')}
    FROM ${qid(stages.get(gs)!.table)} s ON CONFLICT DO NOTHING`);

  const scheme = 'examination_course_exam_scheme';
  await addFKFailure(db, 'course_exam_scheme', 'course missing', `
    SELECT count(*) FROM ${qid(stages.get(scheme)!.table)} s
    LEFT JOIN erp.course co ON co.course_id = ${c(scheme, 'course_id')}::int WHERE co.course_id IS NULL`);
  await merge(db, 'course_exam_scheme', `
    INSERT INTO erp.course_exam_scheme
      (course_id, internal_max, midsem_max, endsem_max, total_max, passing_percentage)
    SELECT co.course_id,
           CASE co.course_type WHEN 'TH' THEN 20 WHEN 'LAB' THEN 50 ELSE ${c(scheme, 'internal_max')}::smallint END,
           CASE co.course_type WHEN 'TH' THEN 20 WHEN 'LAB' THEN 0 ELSE ${c(scheme, 'midsem_max')}::smallint END,
           CASE co.course_type WHEN 'TH' THEN 60 WHEN 'LAB' THEN 50 ELSE ${c(scheme, 'endsem_max')}::smallint END,
           CASE co.course_type WHEN 'TH' THEN 100 WHEN 'LAB' THEN 100 ELSE ${c(scheme, 'total_max')}::smallint END,
           ${c(scheme, 'passing_percentage')}::smallint
    FROM ${qid(stages.get(scheme)!.table)} s JOIN erp.course co ON co.course_id = ${c(scheme, 'course_id')}::int
    ON CONFLICT DO NOTHING`);

  const cycles = 'examination_exam_cycles';
  await addFKFailure(db, 'exam_cycle', 'academic session missing for academic_year/semester_type', `
    SELECT count(*) FROM ${qid(stages.get(cycles)!.table)} s
    LEFT JOIN erp.academic_session a ON a.academic_year = ${c(cycles, 'academic_year')}
      AND a.term_type = upper(${c(cycles, 'semester_type')})::erp.term_type
    WHERE a.session_id IS NULL`);
  await merge(db, 'exam_cycle', `
    INSERT INTO erp.exam_cycle
      (exam_cycle_id, academic_session_id, exam_type, start_date, end_date,
       registration_open, registration_close, status)
    SELECT ${c(cycles, 'exam_cycle_id')}::int, a.session_id, ${c(cycles, 'exam_type')}::erp.exam_kind,
           pg_temp.erp_loader_date(${c(cycles, 'start_date')}), pg_temp.erp_loader_date(${c(cycles, 'end_date')}),
           pg_temp.erp_loader_date(${c(cycles, 'registration_open')}), pg_temp.erp_loader_date(${c(cycles, 'registration_close')}),
           ${c(cycles, 'status')}::erp.exam_cycle_state
    FROM ${qid(stages.get(cycles)!.table)} s
    JOIN erp.academic_session a ON a.academic_year = ${c(cycles, 'academic_year')}
      AND a.term_type = upper(${c(cycles, 'semester_type')})::erp.term_type
    ON CONFLICT DO NOTHING`);

  const sch = 'examination_exam_schedule';
  await addFKFailure(db, 'exam_schedule', 'exam cycle/course missing', `
    SELECT count(*) FROM ${qid(stages.get(sch)!.table)} s
    LEFT JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(sch, 'exam_cycle_id')}::int
    LEFT JOIN erp.course co ON co.course_id = ${c(sch, 'course_id')}::int
    WHERE ec.exam_cycle_id IS NULL OR co.course_id IS NULL`);
  await merge(db, 'exam_schedule', `
    INSERT INTO erp.exam_schedule
      (schedule_id, exam_cycle_id, course_id, exam_mode, exam_date, session, start_time, end_time, duration_min, max_marks)
    SELECT ${c(sch, 'schedule_id')}::int, ec.exam_cycle_id, co.course_id, ${c(sch, 'exam_mode')}::erp.exam_mode,
           pg_temp.erp_loader_date(${c(sch, 'exam_date')}), ${c(sch, 'session')}::erp.exam_session,
           ${c(sch, 'start_time')}::time, ${c(sch, 'end_time')}::time,
           ${c(sch, 'duration_min')}::smallint,
           CASE ${c(sch, 'exam_mode')}::erp.exam_mode
             WHEN 'MidSem' THEN scheme.midsem_max
             WHEN 'EndSem Theory' THEN scheme.endsem_max
             WHEN 'Practical/Oral' THEN scheme.endsem_max
           END
    FROM ${qid(stages.get(sch)!.table)} s
    JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(sch, 'exam_cycle_id')}::int
    JOIN erp.course co ON co.course_id = ${c(sch, 'course_id')}::int
    JOIN erp.course_exam_scheme scheme ON scheme.course_id = co.course_id
    ON CONFLICT DO NOTHING`);

  const reg = 'examination_exam_registration';
  await addFKFailure(db, 'exam_registration', 'student/course/exam cycle missing', `
    SELECT count(*) FROM ${qid(stages.get(reg)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(reg, 'student_number')}
    LEFT JOIN erp.course co ON co.course_id = ${c(reg, 'course_id')}::int
    LEFT JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(reg, 'exam_cycle_id')}::int
    WHERE st.student_id IS NULL OR co.course_id IS NULL OR ec.exam_cycle_id IS NULL`);
  await addDataFailure(db, 'exam_registration', 'registered but portal attendance is absent or below course minimum', `
    SELECT count(*) FROM ${qid(stages.get(reg)!.table)} s
    JOIN erp.student st ON st.student_number = ${c(reg, 'student_number')}
    JOIN erp.course co ON co.course_id = ${c(reg, 'course_id')}::int
    JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(reg, 'exam_cycle_id')}::int
    LEFT JOIN erp.v_student_attendance_by_course a ON a.student_id = st.student_id
       AND a.course_id = co.course_id AND a.academic_session_id = ec.academic_session_id
    WHERE ${c(reg, 'registration_status')} = 'Registered'
      AND (a.attendance_pct IS NULL OR a.attendance_pct < co.min_attendance_pct)`);
  await merge(db, 'exam_registration', `
    INSERT INTO erp.exam_registration
      (registration_id, student_id, course_id, exam_cycle_id, attendance_percentage,
       registration_status, blocked_reason, registered_on)
    SELECT ${c(reg, 'registration_id')}::int, st.student_id, co.course_id, ec.exam_cycle_id,
           ${c(reg, 'attendance_percentage')}::numeric,
           ${c(reg, 'registration_status')}::erp.exam_registration_state,
           nullif(${c(reg, 'blocked_reason')}, ''),
           CASE WHEN nullif(${c(reg, 'registered_on')}, '') IS NULL THEN NULL
                ELSE pg_temp.erp_loader_timestamp(${c(reg, 'registered_on')}) END
    FROM ${qid(stages.get(reg)!.table)} s
    JOIN erp.student st ON st.student_number = ${c(reg, 'student_number')}
    JOIN erp.course co ON co.course_id = ${c(reg, 'course_id')}::int
    JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(reg, 'exam_cycle_id')}::int
    WHERE ${c(reg, 'registration_status')} <> 'Registered'
       OR EXISTS (SELECT 1 FROM erp.v_student_attendance_by_course a
                  WHERE a.student_id = st.student_id AND a.course_id = co.course_id
                    AND a.academic_session_id = ec.academic_session_id
                    AND a.attendance_pct >= co.min_attendance_pct)
    ON CONFLICT DO NOTHING`);

  const hall = 'examination_hall_tickets';
  await addFKFailure(db, 'hall_ticket', 'student/exam cycle missing', `
    SELECT count(*) FROM ${qid(stages.get(hall)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(hall, 'student_number')}
    LEFT JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(hall, 'exam_cycle_id')}::int
    WHERE st.student_id IS NULL OR ec.exam_cycle_id IS NULL`);
  await merge(db, 'hall_ticket', `
    INSERT INTO erp.hall_ticket
      (hall_ticket_id, student_id, exam_cycle_id, hall_ticket_no, courses_registered, courses_blocked, status, issued_on)
    SELECT ${c(hall, 'hall_ticket_id')}::int, st.student_id, ec.exam_cycle_id,
           nullif(${c(hall, 'hall_ticket_no')}, ''), ${c(hall, 'courses_registered')}::smallint,
           ${c(hall, 'courses_blocked')}::smallint, ${c(hall, 'status')}::erp.hall_ticket_state,
           pg_temp.erp_loader_date(${c(hall, 'issued_on')})
    FROM ${qid(stages.get(hall)!.table)} s
    JOIN erp.student st ON st.student_number = ${c(hall, 'student_number')}
    JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(hall, 'exam_cycle_id')}::int
    ON CONFLICT DO NOTHING`);

  const marks = 'examination_exam_marks';
  const markValue = (column: string): string => `nullif(${c(marks, column, 'src')}, '')::numeric`;
  const oldMaximum = (column: string): string => `${c(scheme, column, 'old_scheme')}::numeric`;
  const scaledMark = (value: string, oldMax: string, newMax: string): string =>
    `CASE WHEN ${value} IS NULL OR ${oldMax} = 0 THEN NULL ELSE round(${value} * ${newMax} / ${oldMax}, 1) END`;
  const internalSource = markValue('internal_marks');
  const midsemSource = markValue('midsem_marks');
  const endsemSource = markValue('endsem_marks');
  const internalMaxSource = oldMaximum('internal_max');
  const midsemMaxSource = oldMaximum('midsem_max');
  const endsemMaxSource = oldMaximum('endsem_max');
  const internalMark = `CASE co.course_type
    WHEN 'TH' THEN ${scaledMark(internalSource, internalMaxSource, 'target.internal_max')}
    WHEN 'LAB' THEN ${scaledMark(internalSource, internalMaxSource, 'target.internal_max')}
    ELSE ${internalSource} END`;
  const midsemMark = `CASE
    WHEN co.course_type = 'TH' AND ${midsemMaxSource} > 0
      THEN ${scaledMark(midsemSource, midsemMaxSource, 'target.midsem_max')}
    WHEN co.course_type = 'TH' AND ${midsemMaxSource} = 0
      AND ${c(marks, 'endsem_status', 'src')} <> 'Pending'
      AND (${internalSource} IS NOT NULL OR ${endsemSource} IS NOT NULL)
      THEN round(least(target.midsem_max::numeric, greatest(0.0,
        target.midsem_max * (
          coalesce(${internalSource} / NULLIF(${internalMaxSource}, 0), 0)
          + coalesce(${endsemSource} / NULLIF(${endsemMaxSource}, 0), 0)
        ) / NULLIF(
          (CASE WHEN ${internalSource} IS NOT NULL AND ${internalMaxSource} > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN ${endsemSource} IS NOT NULL AND ${endsemMaxSource} > 0 THEN 1 ELSE 0 END),
          0
        )
        + (mod(st.student_id * 37 + co.course_id * 11 + ${c(marks, 'attempt_no', 'src')}::int * 17, 17) - 8) * 0.1
      )), 1)
    WHEN co.course_type = 'LAB' THEN NULL
    ELSE ${midsemSource} END`;
  const endsemMark = `CASE co.course_type
    WHEN 'TH' THEN ${scaledMark(endsemSource, endsemMaxSource, 'target.endsem_max')}
    WHEN 'LAB' THEN ${scaledMark(endsemSource, endsemMaxSource, 'target.endsem_max')}
    ELSE ${endsemSource} END`;
  await addFKFailure(db, 'exam_marks', 'student number missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(marks, 'student_number')}
    WHERE st.student_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'course id missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.course co ON co.course_id = ${c(marks, 'course_id')}::int
    WHERE co.course_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'exam cycle id missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(marks, 'exam_cycle_id')}::int
    WHERE ec.exam_cycle_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'student number missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(marks, 'student_number')}
    WHERE st.student_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'course id missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.course co ON co.course_id = ${c(marks, 'course_id')}::int
    WHERE co.course_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'exam cycle id missing', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(marks, 'exam_cycle_id')}::int
    WHERE ec.exam_cycle_id IS NULL`);
  await addFKFailure(db, 'exam_marks', 'entered_by faculty id cannot be mapped', `
    SELECT count(*) FROM ${qid(stages.get(marks)!.table)} s
    LEFT JOIN source_faculty_id_map f ON f.source_id = nullif(${c(marks, 'entered_by')}, '')::int AND f.faculty_id IS NOT NULL
    WHERE nullif(${c(marks, 'entered_by')}, '') IS NOT NULL AND f.faculty_id IS NULL`);
  await merge(db, 'exam_marks', `
    INSERT INTO erp.exam_marks
      (marks_id, student_id, course_id, attempt_no, exam_cycle_id, internal_marks, midsem_marks,
       endsem_marks, endsem_status, entered_by, last_updated)
    SELECT ${c(marks, 'marks_id', 'src')}::int, st.student_id, co.course_id,
           ${c(marks, 'attempt_no', 'src')}::smallint, ec.exam_cycle_id,
           ${internalMark}, ${midsemMark}, ${endsemMark},
           ${c(marks, 'endsem_status', 'src')}::erp.exam_mark_state, f.faculty_id,
           pg_temp.erp_loader_timestamp(${c(marks, 'last_updated', 'src')})
    FROM ${qid(stages.get(marks)!.table)} src
    JOIN erp.student st ON st.student_number = ${c(marks, 'student_number', 'src')}
    JOIN erp.course co ON co.course_id = ${c(marks, 'course_id', 'src')}::int
    JOIN erp.course_exam_scheme target ON target.course_id = co.course_id
    JOIN ${qid(stages.get(scheme)!.table)} old_scheme
      ON ${c(scheme, 'course_id', 'old_scheme')}::int = co.course_id
    JOIN erp.exam_cycle ec ON ec.exam_cycle_id = ${c(marks, 'exam_cycle_id', 'src')}::int
    LEFT JOIN source_faculty_id_map f
      ON f.source_id = nullif(${c(marks, 'entered_by', 'src')}, '')::int AND f.faculty_id IS NOT NULL
    WHERE nullif(${c(marks, 'entered_by', 'src')}, '') IS NULL OR f.faculty_id IS NOT NULL
    ON CONFLICT DO NOTHING`);

  const results = 'examination_course_result';
  const semesterToSession = (stage: string, alias = 's'): string => `a.academic_year = ${c(stage, 'academic_year', alias)}
      AND a.term_type = CASE WHEN ${c(stage, 'semester', alias)}::int % 2 = 1
                             THEN 'ODD'::erp.term_type ELSE 'EVEN'::erp.term_type END`;
  await addFKFailure(db, 'course_result', 'student/course/grade/session missing', `
    SELECT count(*) FROM ${qid(stages.get(results)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(results, 'student_number')}
    LEFT JOIN erp.course co ON co.course_id = ${c(results, 'course_id')}::int
    LEFT JOIN erp.grade_scale gs ON gs.grade = ${c(results, 'grade')}
    LEFT JOIN erp.academic_session a ON ${semesterToSession(results)}
    WHERE st.student_id IS NULL OR co.course_id IS NULL OR gs.grade IS NULL OR a.session_id IS NULL`);
  await merge(db, 'course_result', `
    INSERT INTO erp.course_result
      (result_id, student_id, course_id, academic_session_id, semester, attempt_no, total_marks,
       max_marks, percentage, grade, grade_points, result_status, is_final_attempt)
    SELECT ${c(results, 'result_id')}::int, st.student_id, co.course_id, a.session_id,
           ${c(results, 'semester')}::smallint, ${c(results, 'attempt_no')}::smallint,
           normalized.total_marks, normalized.max_marks, scored.percentage,
           grade_row.grade, grade_row.grade_points,
           CASE WHEN scored.percentage >= scheme.passing_percentage
             THEN 'Pass'::erp.exam_result_state ELSE 'Fail'::erp.exam_result_state END,
           coalesce(nullif(${c(results, 'is_final_attempt')}, '')::int, 0) <> 0
    FROM ${qid(stages.get(results)!.table)} s
    JOIN erp.student st ON st.student_number = ${c(results, 'student_number')}
    JOIN erp.course co ON co.course_id = ${c(results, 'course_id')}::int
    JOIN erp.course_exam_scheme scheme ON scheme.course_id = co.course_id
    JOIN erp.academic_session a ON ${semesterToSession(results)}
    CROSS JOIN LATERAL (
      SELECT scheme.total_max::smallint AS max_marks,
             round(${c(results, 'percentage')}::numeric * scheme.total_max / 100.0)::smallint AS total_marks
    ) normalized
    CROSS JOIN LATERAL (
      SELECT round(normalized.total_marks * 100.0 / normalized.max_marks, 2) AS percentage
    ) scored
    JOIN LATERAL (
      SELECT grade, grade_points FROM erp.grade_scale
      WHERE scored.percentage BETWEEN min_percentage AND max_percentage
      ORDER BY min_percentage DESC LIMIT 1
    ) grade_row ON true
    ON CONFLICT DO NOTHING`);

  const sem = 'examination_semester_result';
  await addFKFailure(db, 'semester_result', 'student/academic session missing', `
    SELECT count(*) FROM ${qid(stages.get(sem)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(sem, 'student_number')}
    LEFT JOIN erp.academic_session a ON ${semesterToSession(sem)}
    WHERE st.student_id IS NULL OR a.session_id IS NULL`);
  await merge(db, 'semester_result', `
    INSERT INTO erp.semester_result
      (semester_result_id, student_id, academic_session_id, semester, credits_registered, credits_earned,
       sgpa, backlogs, result_status)
    SELECT ${c(sem, 'semester_result_id')}::int, st.student_id, a.session_id, ${c(sem, 'semester')}::smallint,
           ${c(sem, 'credits_registered')}::smallint, ${c(sem, 'credits_earned')}::smallint,
           ${c(sem, 'sgpa')}::numeric, ${c(sem, 'backlogs')}::smallint,
           ${c(sem, 'result_status')}::erp.semester_result_state
    FROM ${qid(stages.get(sem)!.table)} s
    JOIN erp.student st ON st.student_number = ${c(sem, 'student_number')}
    JOIN erp.academic_session a ON ${semesterToSession(sem)}
    ON CONFLICT DO NOTHING`);

  const cgpa = 'examination_student_cgpa';
  await addFKFailure(db, 'student_cgpa', 'student number missing', `
    SELECT count(*) FROM ${qid(stages.get(cgpa)!.table)} s
    LEFT JOIN erp.student st ON st.student_number = ${c(cgpa, 'student_number')}
    WHERE st.student_id IS NULL`);
  await merge(db, 'student_cgpa', `
    INSERT INTO erp.student_cgpa
      (student_id, semesters_completed, credits_attempted, credits_earned, cgpa, backlog_count)
    SELECT st.student_id, ${c(cgpa, 'semesters_completed')}::smallint,
           ${c(cgpa, 'credits_attempted')}::smallint, ${c(cgpa, 'credits_earned')}::smallint,
           ${c(cgpa, 'cgpa')}::numeric, ${c(cgpa, 'backlog_count')}::smallint
    FROM ${qid(stages.get(cgpa)!.table)} s JOIN erp.student st ON st.student_number = ${c(cgpa, 'student_number')}
    ON CONFLICT DO NOTHING`);

  await db.query('SELECT erp.refresh_exam_results()');
}

async function main(): Promise<void> {
  await withClient(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(`
        CREATE TEMP TABLE loader_init (id int);
        SET LOCAL statement_timeout = 0;
        SET LOCAL search_path = pg_temp, erp, public;
        SET LOCAL TIME ZONE 'Asia/Kolkata';
        CREATE OR REPLACE FUNCTION pg_temp.erp_loader_date(v text) RETURNS date
        LANGUAGE plpgsql IMMUTABLE AS $fn$
        BEGIN
          IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
          IF v ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN RETURN to_date(v, 'YYYY-MM-DD'); END IF;
          IF v ~ '^\\d{2}-\\d{2}-\\d{4}$' THEN RETURN to_date(v, 'DD-MM-YYYY'); END IF;
          IF v ~ '^\\d{2}/\\d{2}/\\d{4}$' THEN RETURN to_date(v, 'DD/MM/YYYY'); END IF;
          RAISE EXCEPTION 'unsupported date format: %', v;
        END $fn$;
        CREATE OR REPLACE FUNCTION pg_temp.erp_loader_timestamp(v text) RETURNS timestamptz
        LANGUAGE plpgsql IMMUTABLE AS $fn$
        BEGIN
          IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
          IF v ~ '^\\d{2}-\\d{2}-\\d{4}' THEN
            RETURN to_timestamp(v, 'DD-MM-YYYY HH24:MI:SS');
          END IF;
          RETURN v::timestamptz;
        END $fn$`);
      await importAcademic(db);
      await importCore(db);
      await importAttendance(db);
      await importExamination(db);
      for (const [table, column] of [
        ['exam_cycle', 'exam_cycle_id'], ['exam_schedule', 'schedule_id'],
        ['exam_registration', 'registration_id'], ['hall_ticket', 'hall_ticket_id'],
        ['exam_marks', 'marks_id'], ['course_result', 'result_id'],
        ['semester_result', 'semester_result_id'],
      ] as const) {
        const seq = `pg_get_serial_sequence('erp.${table}', '${column}')`;
        await db.query(`
          SELECT setval(${seq},
            GREATEST(
              (SELECT coalesce(max(${qid(column)}), 1) FROM erp.${qid(table)}),
              coalesce(pg_sequence_last_value(${seq}::regclass), 1)
            )
          )`);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }

    console.log('Rows by table (new rows inserted / final row count):');
    for (const table of TARGET_TABLES) {
      console.log(`  ${table.padEnd(24)} inserted=${String(inserted.get(table) ?? 0).padStart(8)} total=${await tableCount(db, table)}`);
    }
    console.log('  attendance_summary is trigger-maintained; it is not imported from the Group 3 summary CSV.');
    console.log(`Staged source CSVs: ${sourceCounts.size}`);
    for (const [key, count] of sourceCounts) console.log(`  ${key}: ${count} rows`);
  });

  console.log('Foreign-key failures by target table and cause:');
  if (!fkFailures.size) console.log('  none');
  for (const [cause, count] of [...fkFailures].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${cause}: ${count}`);
  }
  console.log('Other source/data limitations:');
  if (!dataFailures.size) console.log('  none');
  for (const [cause, count] of [...dataFailures].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${cause}: ${count}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
