import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { initializeDatabase } from './database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT) || 5173;

await initializeDatabase();

const app = await createApp({
  beforeError: async (server) => {
    if (dev) {
      const { createServer } = await import('vite');
      const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
      server.use(vite.middlewares);
    } else {
      server.use(express.static(path.join(root, 'dist')));
      server.use((request, response, next) => {
        if (request.method !== 'GET' || request.path.startsWith('/api/') || !request.accepts('html')) return next();
        response.sendFile(path.join(root, 'dist', 'index.html'));
      });
    }
  }
});

app.listen(port, () => console.log(`Tangram server listening on http://127.0.0.1:${port}`));
