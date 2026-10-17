import type { Request } from 'express';
import { pool, type Db } from '../db.js';

/** Append an audit-log entry. Pass the transaction client when the change runs in one. */
export async function audit(
  req: Request | null,
  entry: { action: string; entity: string; entityId?: string | number | null; details?: unknown; userId?: number | null },
  db: Db = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.userId !== undefined ? entry.userId : (req?.user?.userId ?? null),
      entry.action,
      entry.entity,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.details === undefined ? null : JSON.stringify(entry.details),
      req?.ip?.replace(/^::ffff:/, '') ?? null,
    ],
  );
}
