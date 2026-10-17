import { Router } from 'express';
import { academicRouter } from './academic-routes.js';
import { auditRouter } from './audit-routes.js';
import { dashboardRouter } from './dashboard-routes.js';
import { peopleRouter } from './people-routes.js';

export const adminRouter = Router();
adminRouter.use(dashboardRouter);
adminRouter.use(academicRouter);
adminRouter.use(peopleRouter);
adminRouter.use(auditRouter);
