import './style.css';
import { mountGame, unmountGame } from './game.js';
import { mountBuilder, unmountBuilder } from './builder.js';

const app = document.querySelector('#app');

const routeOf = () => {
  const h = location.hash.replace(/^#\/?/, '');
  return h === 'editor' ? 'editor' : 'game';
};

let activeRoute = null;
let mounting = false;

async function renderRoute() {
  const route = routeOf();
  if (route === activeRoute || mounting) return;
  mounting = true;

  if (activeRoute === 'game') unmountGame();
  if (activeRoute === 'editor') unmountBuilder();
  app.replaceChildren();

  if (route === 'editor') {
    mountBuilder(app);
    activeRoute = 'editor';
  } else {
    await mountGame(app);
    if (routeOf() === 'game') activeRoute = 'game';
  }

  mounting = false;
  if (routeOf() !== activeRoute) renderRoute();
}

renderRoute();
window.addEventListener('hashchange', renderRoute);
