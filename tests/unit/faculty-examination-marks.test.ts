import { describe, expect, it } from 'vitest';
import {
  validateFacultyExamMarkEntries,
  type FacultyExamMarkEntry,
} from '../../src/queries/faculty-examination-queries.js';

const entry = (values: Partial<FacultyExamMarkEntry> = {}): FacultyExamMarkEntry => ({
  student_id: 1,
  internal_marks: null,
  midsem_marks: null,
  endsem_marks: null,
  ...values,
});

describe('faculty examination mark validation', () => {
  it('accepts valid theory components against configured maxima', () => {
    expect(() => validateFacultyExamMarkEntries([
      entry({ internal_marks: 15, midsem_marks: 18, endsem_marks: 55 }),
    ], { internal_max: 20, midsem_max: 20, endsem_max: 60 })).not.toThrow();
  });

  it('rejects midsem marks for a lab course even when the submitted value is zero', () => {
    expect(() => validateFacultyExamMarkEntries([
      entry({ internal_marks: 40, midsem_marks: 0, endsem_marks: 45 }),
    ], { internal_max: 50, midsem_max: 0, endsem_max: 50 }))
      .toThrow('Midsem marks are not applicable for this course.');
  });

  it('rejects a component score above its configured maximum', () => {
    expect(() => validateFacultyExamMarkEntries([
      entry({ internal_marks: 21 }),
    ], { internal_max: 20, midsem_max: 20, endsem_max: 60 }))
      .toThrow('Internal marks must be between 0 and 20.');
  });

  it('rejects negative marks', () => {
    expect(() => validateFacultyExamMarkEntries([
      entry({ endsem_marks: -0.1 }),
    ], { internal_max: 20, midsem_max: 20, endsem_max: 60 }))
      .toThrow('Endsem marks must be between 0 and 60.');
  });
});
