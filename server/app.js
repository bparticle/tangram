import express from 'express';
import {
  createLevel, deleteLevel, getLevel, listLevels, updateLevel
} from './database.js';
import { loginHandler, logoutHandler, requireAdmin, sessionHandler } from './auth.js';

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
}

// Builds the API. Reads are public so anyone can play; writes are gated behind
// the single-superuser session. `beforeError` lets the local server slot static
// or Vite middleware in ahead of the error handler — the Netlify Function omits
// it, since the CDN serves the static site there.
export async function createApp({ beforeError } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.post('/api/login', loginHandler);
  app.post('/api/logout', logoutHandler);
  app.get('/api/session', sessionHandler);

  app.get('/api/levels', asyncRoute(async (_request, response) => response.json(await listLevels())));
  app.get('/api/levels/:id', asyncRoute(async (request, response) => {
    const level = await getLevel(request.params.id);
    if (!level) return response.status(404).json({ error: 'Level not found' });
    response.json(level);
  }));
  app.post('/api/levels', requireAdmin, asyncRoute(async (request, response) => {
    response.status(201).json(await createLevel(request.body));
  }));
  app.put('/api/levels/:id', requireAdmin, asyncRoute(async (request, response) => {
    const level = await updateLevel(request.params.id, request.body);
    if (!level) return response.status(404).json({ error: 'Level not found' });
    response.json(level);
  }));
  app.delete('/api/levels/:id', requireAdmin, asyncRoute(async (request, response) => {
    if (!await deleteLevel(request.params.id)) return response.status(404).json({ error: 'Level not found' });
    response.status(204).end();
  }));

  if (beforeError) await beforeError(app);

  app.use((error, _request, response, _next) => {
    console.error(error);
    if (error?.code === '23505') return response.status(409).json({ error: 'A level with this id already exists' });
    // Validation errors carry an explicit 4xx status; body-parser errors (bad JSON,
    // oversized payload) do too. Everything else is an unexpected server fault.
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    response.status(status).json({ error: status === 500 ? 'Database request failed' : error.message });
  });

  return app;
}
