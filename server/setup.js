import 'dotenv/config';
import { initializeDatabase, listLevels } from './database.js';

await initializeDatabase();
const levels = await listLevels();
console.log(`Database ready with ${levels.length} level${levels.length === 1 ? '' : 's'}.`);
