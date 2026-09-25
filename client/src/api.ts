export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // The custom header is our CSRF guard: other sites can't send it without a CORS preflight.
    headers: { 'x-requested-with': 'tutoring-web', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path.startsWith('/admin')) window.dispatchEvent(new Event('auth-expired'));
    throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T = unknown>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const patch = <T = unknown>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const put = <T = unknown>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T = unknown>(p: string) => api<T>(p, { method: 'DELETE' });
