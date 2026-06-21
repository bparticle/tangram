async function request(path, options) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options?.body ? { 'content-type': 'application/json', ...options.headers } : options?.headers
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function getSession() {
  return request('/api/session');
}

export function login(password) {
  return request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export function logout() {
  return request('/api/logout', { method: 'POST' });
}
