import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'Page not found'));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  const message = err instanceof HttpError ? err.message : 'Something went wrong on our side. Please try again.';
  res.status(status);
  if (req.accepts(['html', 'json']) === 'json') {
    res.json({ error: message });
    return;
  }
  res.render('error', { title: status === 404 ? 'Not found' : 'Error', status, message, nav: null });
}
