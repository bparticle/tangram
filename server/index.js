import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  createLevel, deleteLevel, getLevel, initializeDatabase, listLevels, updateLevel
} from './database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT) || 5173;

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
}

await initializeDatabase();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/api/levels', asyncRoute(async (_request, response) => response.json(await listLevels())));
app.get('/api/levels/:id', asyncRoute(async (request, response) => {
  const level = await getLevel(request.params.id);
  if (!level) return response.status(404).json({ error: 'Level not found' });
  response.json(level);
}));
app.post('/api/levels', asyncRoute(async (request, response) => {
  response.status(201).json(await createLevel(request.body));
}));
app.put('/api/levels/:id', asyncRoute(async (request, response) => {
  const level = await updateLevel(request.params.id, request.body);
  if (!level) return response.status(404).json({ error: 'Level not found' });
  response.json(level);
}));
app.delete('/api/levels/:id', asyncRoute(async (request, response) => {
  if (!await deleteLevel(request.params.id)) return response.status(404).json({ error: 'Level not found' });
  response.status(204).end();
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error?.code === '23505') return response.status(409).json({ error: 'A level with this id already exists' });
  // Validation errors carry an explicit 4xx status; body-parser errors (bad JSON,
  // oversized payload) do too. Everything else is an unexpected server fault.
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  response.status(status).json({ error: status === 500 ? 'Database request failed' : error.message });
});

if (dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, 'dist')));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/') || !request.accepts('html')) return next();
    response.sendFile(path.join(root, 'dist', 'index.html'));
  });
}

app.listen(port, () => console.log(`Tangram server listening on http://127.0.0.1:${port}`));
