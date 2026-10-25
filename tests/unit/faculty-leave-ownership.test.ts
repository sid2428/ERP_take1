import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, queryOne } = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../src/db.js', () => ({ query, queryOne }));

import { cancelLeaveRequest } from '../../src/queries/faculty-queries.js';

describe('faculty leave cancellation ownership', () => {
  beforeEach(() => {
    query.mockReset();
    queryOne.mockReset();
  });

  it('does not cancel a leave request owned by another faculty member', async () => {
    queryOne.mockResolvedValue(undefined);

    await expect(cancelLeaveRequest(41, 7)).rejects.toThrow('Leave request not found.');
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('leave_request_id = $1 AND faculty_id = $2'), [41, 7],
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('allows a faculty member to cancel their own leave request', async () => {
    queryOne.mockResolvedValue({ leave_request_id: 41 });
    query.mockResolvedValue([]);

    await expect(cancelLeaveRequest(41, 7, 'Changed plans')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('CALL cancel_faculty_leave($1, $2)', [41, 'Changed plans']);
  });
});
