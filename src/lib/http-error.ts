export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Page'): HttpError => new HttpError(404, `${what} not found`);
export const forbidden = (): HttpError => new HttpError(403, 'You do not have access to this page');
