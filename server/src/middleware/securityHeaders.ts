import { RequestHandler } from 'express';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export const securityHeadersMiddleware: RequestHandler = (_req, res, next) => {
  for (const [header, value] of Object.entries(securityHeaders)) {
    res.setHeader(header, value);
  }

  next();
};
