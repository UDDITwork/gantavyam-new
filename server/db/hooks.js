'use strict';

/**
 * Middleware runner with the same semantics as Mongoose's (kareem): a hook may take a `next`
 * callback, return a promise, or both. `next` only counts the first time it is called, so hooks
 * like `async function (next) { if (!changed) { next(); } ...rest... }` behave as they do today.
 */

function runPreHook(fn, ctx, args) {
  return new Promise((resolve, reject) => {
    let called = false;
    const next = (error) => {
      if (called) return;
      called = true;
      if (error) reject(error);
      else resolve();
    };

    let result;
    try {
      result = fn.length > 0 ? fn.call(ctx, next, ...args) : fn.call(ctx, ...args);
    } catch (error) {
      next(error);
      return;
    }

    if (result && typeof result.then === 'function') {
      result.then(() => next(), (error) => next(error));
    } else if (fn.length === 0) {
      next();
    }
  });
}

async function runPre(hooks, ctx, args = []) {
  for (const fn of hooks || []) {
    await runPreHook(fn, ctx, args);
  }
}

async function runPost(hooks, ctx, args = []) {
  for (const fn of hooks || []) {
    if (fn.length >= 2) {
      await new Promise((resolve, reject) => {
        let called = false;
        const next = (error) => {
          if (called) return;
          called = true;
          if (error) reject(error);
          else resolve();
        };
        try {
          const result = fn.call(ctx, args[0], next);
          if (result && typeof result.then === 'function') result.then(() => next(), next);
        } catch (error) {
          next(error);
        }
      });
    } else {
      await fn.call(ctx, args[0]);
    }
  }
}

module.exports = { runPre, runPost };
