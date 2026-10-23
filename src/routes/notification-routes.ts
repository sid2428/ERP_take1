import { Router } from 'express';
import { notificationState } from '../queries/notice-queries.js';

/** Small authenticated API used by the shared notification bell. */
export const notificationRouter = Router();

notificationRouter.get('/state', async (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const state = await notificationState(req.user.userId);
    res.set('Cache-Control', 'no-store').json(state);
  } catch (err) {
    next(err);
  }
});
