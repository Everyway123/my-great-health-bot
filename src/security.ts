// Zero Trust: every incoming Telegram update is checked against
// ALLOWED_USER_IDS before any handler runs. Same posture as Hermes.

import { Context, NextFunction } from 'grammy';
import { log } from './logger.js';

export function isAuthorizedUser(userId: number, allowedIds: number[]): boolean {
  return allowedIds.includes(userId);
}

export class RateLimiter {
  private requests: Map<number, number[]> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  check(userId: number): boolean {
    const now = Date.now();
    const valid = (this.requests.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (valid.length >= this.maxRequests) {
      log({ level: 'warn', action: 'rate_limit_exceeded', userId });
      return false;
    }
    valid.push(now);
    this.requests.set(userId, valid);
    return true;
  }
}

const rateLimiter = new RateLimiter(30, 60_000);

export function authMiddleware(allowedUserIds: number[]) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorizedUser(userId, allowedUserIds)) {
      log({ level: 'warn', action: 'unauthorized_access', userId: userId ?? 0, details: { username: ctx.from?.username } });
      return;
    }
    if (!rateLimiter.check(userId)) {
      await ctx.reply('Зачекай хвилинку ⏳');
      return;
    }
    await next();
  };
}
