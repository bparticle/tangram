import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';
import { initializeDatabase } from '../../server/database.js';

// One Netlify Function fronts the whole Express API. Neon's HTTP driver makes
// this serverless-friendly — no pooled connection to keep warm. The wrapped
// handler is built once per cold start and reused across invocations.
let cached;
async function getHandler() {
  if (!cached) {
    await initializeDatabase();
    cached = serverless(await createApp());
  }
  return cached;
}

// The `/api/*` redirect lands here as `/.netlify/functions/api/<rest>`; map it
// back to the `/api/<rest>` paths the Express routes are declared with.
function normalizePath(value) {
  const stripped = String(value || '').replace(/^\/\.netlify\/functions\/api/, '');
  return stripped.startsWith('/api') ? stripped : `/api${stripped || '/'}`;
}

export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  event.path = normalizePath(event.path);
  const wrapped = await getHandler();
  return wrapped(event, context);
};
