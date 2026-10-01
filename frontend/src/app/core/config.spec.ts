import { loadRuntimeConfig } from './config';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const complete = {
  apiBase: '/api/v2',
  keycloakUrl: 'http://localhost:18180',
  realm: 'daily2',
  clientId: 'daily2-app',
};

describe('loadRuntimeConfig', () => {
  it('reads the four settings from assets/runtime-config.json', async () => {
    const fetchFn = vi.fn(fakeFetch(200, { ...complete, extra: 1 }));
    await expect(loadRuntimeConfig(fetchFn as typeof fetch)).resolves.toEqual(complete);
    expect(fetchFn).toHaveBeenCalledWith('assets/runtime-config.json', { cache: 'no-store' });
  });

  it('names missing settings', async () => {
    await expect(loadRuntimeConfig(fakeFetch(200, { apiBase: '/api/v2' }))).rejects.toThrow(
      'runtime-config.json is missing keycloakUrl, realm, clientId',
    );
  });

  it('fails on an HTTP error', async () => {
    await expect(loadRuntimeConfig(fakeFetch(404, {}))).rejects.toThrow(
      'runtime-config.json: HTTP 404',
    );
  });

  it('treats an empty string as missing', async () => {
    await expect(loadRuntimeConfig(fakeFetch(200, { ...complete, realm: '' }))).rejects.toThrow(
      'runtime-config.json is missing realm',
    );
  });

  it('names the file when the body is not JSON', async () => {
    const html = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(loadRuntimeConfig(html)).rejects.toThrow('runtime-config.json is not valid JSON');
  });

  it.each([null, [], 'text', 3])(
    'names the file when the JSON is %j, not an object',
    async (body) => {
      await expect(loadRuntimeConfig(fakeFetch(200, body))).rejects.toThrow(
        'runtime-config.json must contain a JSON object',
      );
    },
  );
});
