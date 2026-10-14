'use strict';
const { route, checkAuth, cleanModel } = require('./_lib');

// Tells the page which models exist and whether a password is needed. Never returns the key.
module.exports = route(
  async (req) => {
    const passwordRequired = !!process.env.APP_PASSWORD;
    return {
      passwordRequired,
      authorized: !passwordRequired || checkAuth(req),
      hasKey: !!process.env.OPENAI_API_KEY,
      model: cleanModel(),
    };
  },
  { method: 'GET', auth: false }
);
