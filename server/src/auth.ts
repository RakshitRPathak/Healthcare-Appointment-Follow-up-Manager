import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from './config';
import { AppError } from './errors';

export type Role = 'PATIENT' | 'DOCTOR' | 'ADMIN';
export interface AuthUser { id: string; role: Role }
declare module 'express-serve-static-core' { interface Request { user?: AuthUser } }

export const signToken = (u: AuthUser, secret = config.jwtSecret) =>
  jwt.sign({ role: u.role }, secret, { subject: u.id, expiresIn: '8h', algorithm: 'HS256' });

export function authenticate(secret = config.jwtSecret): RequestHandler {
  return (req, _res, next) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
    try {
      const p = jwt.verify(h.slice(7), secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      req.user = { id: String(p.sub), role: p.role as Role };
      next();
    } catch { next(new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token')); }
  };
}

export const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) =>
  roles.includes(req.user!.role) ? next() : next(new AppError(403, 'FORBIDDEN', 'Not allowed for your role'));

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };
