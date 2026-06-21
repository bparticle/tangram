const LEGACY_KEY = 'ma_tangram_custom_levels_v1';

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { 'content-type': 'application/json', ...options.headers } : options?.headers
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Level request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

async function migrateLegacyLevels() {
  let levels;
  try { levels = JSON.parse(localStorage.getItem(LEGACY_KEY)) || []; } catch { levels = []; }
  if (!Array.isArray(levels) || !levels.length) { localStorage.removeItem(LEGACY_KEY); return; }
  // Best-effort, one-shot migration. A single malformed cached level must not
  // brick the app or block the others, so failures are logged and skipped — and
  // the key is always cleared afterwards so we never retry on the next load.
  for (const level of levels) {
    try {
      await request('/api/levels', { method: 'POST', body: JSON.stringify(level) });
    } catch (error) {
      if (!error.message.includes('already exists')) console.warn('Skipped legacy level during migration:', error.message);
    }
  }
  localStorage.removeItem(LEGACY_KEY);
}

export async function listLevels() {
  await migrateLegacyLevels();
  return request('/api/levels');
}

export function createLevel(level) {
  return request('/api/levels', { method: 'POST', body: JSON.stringify(level) });
}

export function updateLevel(id, level) {
  return request(`/api/levels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(level) });
}

export function deleteLevel(id) {
  return request(`/api/levels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
