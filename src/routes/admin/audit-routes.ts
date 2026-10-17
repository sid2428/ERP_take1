import { Router } from 'express';
import { query, queryOne } from '../../db.js';
import { pageInfo, parsePage, withQuery } from '../../lib/pagination.js';

export const auditRouter = Router();

auditRouter.get('/audit', async (req, res) => {
  const filters = {
    action: typeof req.query.action === 'string' ? req.query.action.trim().toUpperCase().slice(0, 40) : '',
    user: typeof req.query.user === 'string' ? req.query.user.trim().slice(0, 20) : '',
  };
  const page = parsePage(req.query.page);
  const where = `($1::text = '' OR a.action = $1::text) AND ($2::text = '' OR u.login_id ILIKE $2::text)`;
  const [rows, count, actions] = await Promise.all([
    query(`SELECT a.audit_id, a.occurred_at, a.action, a.entity, a.entity_id, a.details, a.ip_address::text AS ip, u.login_id, u.role
           FROM audit_log a LEFT JOIN app_user u USING (user_id) WHERE ${where}
           ORDER BY a.audit_id DESC LIMIT $3 OFFSET $4`, [filters.action, filters.user, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM audit_log a LEFT JOIN app_user u USING (user_id) WHERE ${where}`,
      [filters.action, filters.user]),
    query<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action'),
  ]);
  res.render('admin/audit', {
    title: 'Audit log', nav: 'audit', rows, filters, actions: actions.map((a) => a.action),
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});
