import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const password = 'test-only-password-12345';
const providerPassword = 'provider-secret-never-expose';
async function waitReady(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Server not ready');
}

test('production refuses an absent application password', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, NODE_ENV: 'production', XTREAM_URL: 'http://127.0.0.1',
      XTREAM_USERNAME: 'test', XTREAM_PASSWORD: 'test', APP_PASSWORD: '' }, stdio: 'pipe',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});

test('authentication, catalogue and encrypted HLS proxy work together', async (t) => {
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action');
      const data = action === 'get_live_categories' ? [{ category_id: '1', category_name: 'Haber' }]
        : action === 'get_live_streams' ? [{ stream_id: 42, name: 'Gündem', category_id: '1' }]
          : { user_info: { status: 'Active', password: providerPassword } };
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(data));
    }
    if (/\/43\.(ts|m3u8)$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      return res.end('<html><body>XUI.ONE FORCED_COUNTRY_INVALID Country does not match forced country.</body></html>');
    }
    if (url.pathname.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="/key/${providerPassword}"\n#EXTINF:6,\n/segments/${providerPassword}.ts\n`);
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.end('mock-media-data');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const portProbe = http.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
      XTREAM_URL: `http://127.0.0.1:${upstream.address().port}`, XTREAM_USERNAME: 'mock-user',
      XTREAM_PASSWORD: providerPassword, APP_PASSWORD: password }, stdio: 'pipe',
  });
  t.after(async () => {
    child.kill();
    await once(child, 'exit');
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  await waitReady(base, child);
  assert.equal((await fetch(base)).status, 200);
  for (const file of ['/vendor/hls.min.js', '/vendor/mpegts.min.js', '/app.js', '/styles.css'])
    assert.equal((await fetch(base + file)).status, 200, file);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  for (const route of ['/api/live/categories', '/api/account', '/api/playback/42', '/live/42.m3u8', '/hls/seg?token=x'])
    assert.equal((await fetch(base + route)).status, 401, route);
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(cookieHeader.includes(flag));
  const headers = { Cookie: cookieHeader.split(';')[0] };
  const catalogue = await (await fetch(`${base}/api/live/categories`, { headers })).json();
  assert.equal(catalogue.total, 1);
  const found = await (await fetch(`${base}/api/live/streams?q=gundem`, { headers })).json();
  assert.equal(found.items[0].id, 42);
  const sources = await (await fetch(`${base}/api/playback/42`, { headers })).json();
  assert.deepEqual(sources, { mode: 'proxy', ts: '/live/42.ts', hls: '/live/42.m3u8' });
  assert.equal((await fetch(`${base}/api/playback/999`, { headers })).status, 404);
  const account = await (await fetch(`${base}/api/account`, { headers })).text();
  assert.ok(!account.includes(providerPassword));
  for (const ext of ['ts', 'm3u8']) {
    const blocked = await fetch(`${base}/live/43.${ext}`, { headers });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, 'COUNTRY_RESTRICTED');
  }
  const playlist = await (await fetch(`${base}/live/42.m3u8`, { headers })).text();
  assert.ok(playlist.startsWith('#EXTM3U'));
  assert.ok(!playlist.includes(providerPassword));
  assert.ok(!playlist.includes('mock-user'));
  const segment = playlist.trim().split('\n').at(-1);
  const token = new URL(segment, base).searchParams.get('token');
  assert.ok(!Buffer.from(token, 'base64url').toString().includes(providerPassword));
  assert.equal(await (await fetch(base + segment, { headers })).text(), 'mock-media-data');
  assert.equal((await fetch(base + segment.replace('/hls/seg', '/hls/pl'), { headers })).status, 403);
  const tampered = new URL(segment, base);
  const bytes = Buffer.from(token, 'base64url');
  bytes[bytes.length - 1] ^= 1;
  tampered.searchParams.set('token', bytes.toString('base64url'));
  assert.equal((await fetch(tampered, { headers })).status, 403);
  assert.equal((await fetch(`${base}/hls/seg?u=b2xk&s=invalid`, { headers })).status, 403);
});

test('direct playback is explicit and authenticated; proxy remains the default', async (t) => {
  const provider = http.createServer((req, res) => {
    const action = new URL(req.url, 'http://localhost').searchParams.get('action');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(action === 'get_live_categories'
      ? [{ category_id: '1', category_name: 'Test' }]
      : [{ stream_id: 42, category_id: '1', name: 'Test' }]));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
      XTREAM_URL: providerBase, XTREAM_USERNAME: 'test user', XTREAM_PASSWORD: 'test/pass',
      APP_PASSWORD: password, STREAM_MODE: 'direct' }, stdio: 'pipe',
  });
  t.after(async () => {
    child.kill();
    await once(child, 'exit');
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  await waitReady(base, child);
  assert.equal((await fetch(`${base}/api/playback/42`)).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(`${base}/api/playback/42`, { headers });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const sources = await response.json();
  assert.deepEqual(sources, { mode: 'direct', ts: `${providerBase}/live/test%20user/test%2Fpass/42.ts`, hls: `${providerBase}/live/test%20user/test%2Fpass/42.m3u8` });
  const csp = (await fetch(base)).headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' https:/);
  assert.match(csp, /media-src 'self' blob: https:/);
});
