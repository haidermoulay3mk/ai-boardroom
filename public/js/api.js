async function request(method, url, body) {
  const init = { method, headers: {} };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, init);
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

const session = id => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
  health: () => request('GET', '/api/health'),
  advisors: () => request('GET', '/api/advisors'),
  sessions: () => request('GET', '/api/sessions'),
  session: id => request('GET', session(id)),
  create: body => request('POST', '/api/sessions', body),
  warm: model => request('POST', '/api/warm', { model }),
  answer: (id, answers) => request('POST', `${session(id)}/answer`, { answers }),
  interject: (id, text) => request('POST', `${session(id)}/interject`, { text }),
  cancel: id => request('POST', `${session(id)}/cancel`),
  resume: id => request('POST', `${session(id)}/resume`),
  remove: id => request('DELETE', session(id)),
  events: id => new EventSource(`${session(id)}/events`),
  pdfUrl: id => `${session(id)}/report.pdf`,
  mdUrl: id => `${session(id)}/report.md`,
};
