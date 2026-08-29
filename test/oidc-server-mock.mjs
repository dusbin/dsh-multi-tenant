/**
 * 最小 OIDC Provider 模拟（仅用于开发/测试/冒烟，非生产组件）。
 *
 * 实现 openid-client 跑通 Authorization Code + PKCE 所需的最小端点：
 *  - GET  /.well-known/openid-configuration   发现文档
 *  - GET  /jwks                               RSA 公钥（JWK）
 *  - GET  /authorize?…                         302 → redirect_uri?code&state（记录 PKCE challenge）
 *  - POST /token                              校验 code_verifier（PKCE）→ id_token(RS256)+access_token
 *
 * 用法：startOidcMock({ issuer, users }) → { port, close, users }
 *   users: [{ sub, preferred_username, email, name }]（密码固定 'secret'，供 /authorize 模拟）
 */

import http from 'node:http';
import crypto from 'node:crypto';

const b64 = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');

function signJwt({ privateKey, header, payload }) {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  return `${signingInput}.${sig}`;
}

export async function startOidcMock({ users = [{ sub: 'sub-1', preferred_username: 'sso.user', email: 'sso@example.com', name: 'SSO User' }] } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'test-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  const codes = new Map(); // code → { challenge, redirectUri, user }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const issuer = `http://127.0.0.1:${server.address().port}`;

    if (path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    }
    if (path === '/jwks') {
      return json(res, 200, { keys: [publicJwk] });
    }
    if (path === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const challenge = url.searchParams.get('code_challenge');
      const user = users[0];
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { challenge, redirectUri, user });
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state || '')}` });
      res.end();
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const code = params.get('code');
        const verifier = params.get('code_verifier');
        const entry = codes.get(code);
        if (!entry) return json(res, 400, { error: 'invalid_grant' });
        const challenge = crypto.createHash('sha256').update(verifier || '').digest('base64url');
        if (challenge !== entry.challenge) return json(res, 400, { error: 'invalid_grant' });
        codes.delete(code);
        const now = Math.floor(Date.now() / 1000);
        const user = entry.user;
        const idToken = signJwt({
          privateKey,
          header: { alg: 'RS256', kid: 'test-key', typ: 'JWT' },
          payload: {
            iss: issuer,
            sub: user.sub,
            aud: 'my-client',
            exp: now + 3600,
            iat: now,
            preferred_username: user.preferred_username,
            email: user.email,
            name: user.name,
          },
        });
        json(res, 200, {
          access_token: `mock-at-${code}`,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken,
        });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  function json(res, status, body) {
    if (process.env.OIDC_MOCK_DEBUG) console.log('[oidc-mock] json:', status, typeof body, body && Object.keys(body).slice(0,5).join(','));
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        issuer: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
