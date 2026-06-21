import { neon } from '@neondatabase/serverless';
import { INITIAL_LEVELS } from './initial-levels.js';

const PIECE_IDS = ['mountain', 'shadow', 'reed', 'stone', 'bridge', 'wing', 'beak'];
let sql;

// A bad request body is the caller's fault, not the database's. Tagging these
// with an HTTP status lets the error handler answer 400 instead of a blanket 500.
function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function database() {
  if (!sql) {
    if (!process.env.DATABASE) throw new Error('DATABASE is not configured');
    sql = neon(process.env.DATABASE);
  }
  return sql;
}

function rowToLevel(row) {
  return {
    id: row.id,
    name: row.name,
    difficulty: row.difficulty,
    solutionMoves: row.solution_moves,
    start: row.start,
    targets: row.targets,
    position: row.position
  };
}

export function validateLevel(input, forcedId) {
  const level = input && typeof input === 'object' ? input : {};
  const id = forcedId || level.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw invalid('Level id must contain 1-64 lowercase letters, numbers, hyphens, or underscores');
  }
  if (typeof level.name !== 'string' || !level.name.trim() || level.name.trim().length > 100) {
    throw invalid('Level name must contain 1-100 characters');
  }
  for (const field of ['targets', ...(level.start == null ? [] : ['start'])]) {
    if (!level[field] || typeof level[field] !== 'object') throw invalid(`${field} placements are required`);
    for (const pieceId of PIECE_IDS) {
      const placement = level[field][pieceId];
      if (!Array.isArray(placement) || placement.length < 3 || placement.length > 4 ||
          placement.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw invalid(`${field}.${pieceId} must be a numeric [x, y, rotation] placement`);
      }
      if (placement.length === 4 && placement[3] !== -1 && placement[3] !== 1) {
        throw invalid(`${field}.${pieceId} has an invalid mirror value`);
      }
    }
  }
  return {
    id,
    name: level.name.trim(),
    difficulty: typeof level.difficulty === 'string' ? level.difficulty.slice(0, 20) : null,
    solutionMoves: Number.isInteger(level.solutionMoves) && level.solutionMoves >= 0 ? level.solutionMoves : null,
    start: level.start || null,
    targets: level.targets,
    position: Number.isInteger(level.position) && level.position >= 0 ? level.position : null
  };
}

export async function initializeDatabase() {
  const db = database();
  await db`CREATE TABLE IF NOT EXISTS levels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    difficulty TEXT,
    solution_moves INTEGER,
    start JSONB,
    targets JSONB NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  const seeded = await db`SELECT value FROM app_meta WHERE key = 'initial_levels_seeded'`;
  if (!seeded.length) {
    for (const [position, source] of INITIAL_LEVELS.entries()) {
      const level = validateLevel({ ...source, position });
      await db`INSERT INTO levels (id, name, difficulty, solution_moves, start, targets, position)
        VALUES (${level.id}, ${level.name}, ${level.difficulty}, ${level.solutionMoves}, ${level.start}, ${level.targets}, ${position})
        ON CONFLICT (id) DO NOTHING`;
    }
    await db`INSERT INTO app_meta (key, value) VALUES ('initial_levels_seeded', ${JSON.stringify({ version: 1 })}::jsonb)
      ON CONFLICT (key) DO NOTHING`;
  }
}

export async function listLevels() {
  const rows = await database()`SELECT id, name, difficulty, solution_moves, start, targets, position
    FROM levels ORDER BY position ASC, created_at ASC, id ASC`;
  return rows.map(rowToLevel);
}

export async function getLevel(id) {
  const rows = await database()`SELECT id, name, difficulty, solution_moves, start, targets, position
    FROM levels WHERE id = ${id}`;
  return rows[0] ? rowToLevel(rows[0]) : null;
}

export async function createLevel(input) {
  const level = validateLevel(input);
  const rows = await database()`INSERT INTO levels (id, name, difficulty, solution_moves, start, targets, position)
    VALUES (
      ${level.id}, ${level.name}, ${level.difficulty}, ${level.solutionMoves}, ${level.start}, ${level.targets},
      COALESCE(${level.position}, (SELECT COALESCE(MAX(position), -1) + 1 FROM levels))
    )
    RETURNING id, name, difficulty, solution_moves, start, targets, position`;
  return rowToLevel(rows[0]);
}

export async function updateLevel(id, input) {
  const level = validateLevel(input, id);
  const rows = await database()`UPDATE levels SET
      name = ${level.name}, difficulty = ${level.difficulty}, solution_moves = ${level.solutionMoves},
      start = ${level.start}, targets = ${level.targets}, position = COALESCE(${level.position}, position), updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, difficulty, solution_moves, start, targets, position`;
  return rows[0] ? rowToLevel(rows[0]) : null;
}

export async function deleteLevel(id) {
  const rows = await database()`DELETE FROM levels WHERE id = ${id} RETURNING id`;
  return Boolean(rows.length);
}
