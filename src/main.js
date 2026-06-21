import './style.css';
import { mountGame } from './game.js';
import { mountBuilder } from './builder.js';

const app = document.querySelector('#app');

// Two routes share the app shell: the game, and the level editor at #editor.
// Switching between them reloads so each mounts cleanly (no leaked
// global listeners); in-page anchors like #board don't count as a route change.
const routeOf = () => {
  const h = location.hash.replace(/^#\/?/, '');
  return h === 'editor' ? 'editor' : 'game';
};

const current = routeOf();
if (current === 'editor') mountBuilder(app);
else mountGame(app);

window.addEventListener('hashchange', () => {
  if (routeOf() !== current) location.reload();
});
