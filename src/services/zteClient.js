// ZTE CPE protocol clients (no external dependencies).
//
// Protocol details were extracted from each device's own firmware JS:
//
// INDOOR (ZTE "Smart Hub" web UI, goform API):
//   1. GET  /goform/goform_get_cmd_process?isTest=false&cmd=LD&multi_data=1  -> {"LD":"<token>"}
//   2. POST /goform/goform_set_cmd_process  body: isTest=false&goformId=LOGIN&password=<sha256(sha256(pw)+LD)>
//      -> {"result":"0"} + Set-Cookie: LD_WEB_SESSION=...
//   3. GET  .../goform_get_cmd_process?isTest=false&cmd=<CMDS>&multi_data=1  (with session cookie)
//      result "3" == bad password / session kicked.
//
// OUTDOOR (ZTE MC8830, ubus-over-HTTP JSON-RPC):
//   POST /ubus/?t=<ms>  body: [{"jsonrpc":"2.0","method":"call","params":["<session>","<object>","<method>",{...}],"id":n}]
//   - Anonymous session id: "00000000000000000000000000000000"
//   - Referer header is REQUIRED by the device.
//   - Login: zwrt_web/web_login_info -> zte_web_sault; then zwrt_web/web_login
//     {password: sha256(sha256(pw)+sault)} -> ubus_rpc_session (stok).
//   - Session expiry surfaces as ubus error code -32002.

const http = require('http');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ANON_SESSION = '00000000000000000000000000000000';
// Pause window after a failed CPE login. ZTE locks the web UI for 30 minutes
// after 5 consecutive failures, so automatic retries must back off.
const AUTH_BACKOFF_MS = 10 * 60 * 1000;

class CpeAuthError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CpeAuthError';
    this.code = 'AUTH_FAILED';
    this.detail = detail || '';
  }
}
class CpeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CpeError';
    this.code = 'CPE_ERROR';
  }
}

function request({ host, path, method = 'GET', headers = {}, body = null, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: 80, path, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new CpeError('Connection to CPE timed out')));
    req.on('error', (err) =>
      reject(
        ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH'].includes(err.code)
          ? new CpeError(`CPE unreachable (${err.code})`)
          : err
      )
    );
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// INDOOR — goform API client
// ---------------------------------------------------------------------------
class ZteGoformClient {
  constructor(host, password) {
    this.host = host;
    this.password = password;
    this.cookie = null;
    this.loginPromise = null;
    // After a failed login we stop retrying for a while: ZTE firmware locks the
    // web UI for 30 minutes after 5 consecutive failures, so hammering is harmful.
    this.authBlockedUntil = 0;
  }

  headers(extra = {}) {
    const h = { Referer: `http://${this.host}/index.html`, ...extra };
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  extractSessionCookie(res) {
    const raw = res.headers['set-cookie'];
    if (!raw) return;
    const found = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('LD_WEB_SESSION='));
    if (found && !found.endsWith('=')) this.cookie = found;
  }

  async login() {
    if (!this.password) {
      throw new CpeAuthError('No password configured for the indoor CPE (set CPE_INDOOR_PASSWORD or CPE_ADMIN_PASSWORD in .env)');
    }
    const tokenRes = await request({
      host: this.host,
      path: '/goform/goform_get_cmd_process?isTest=false&cmd=LD&multi_data=1',
      headers: this.headers(),
    });
    let token;
    try {
      token = JSON.parse(tokenRes.body).LD;
    } catch (_) {
      throw new CpeError('Unexpected token response from indoor CPE');
    }
    if (!token) throw new CpeError('Indoor CPE did not issue a session token');

    const pw = sha256(sha256(this.password) + token);
    const res = await request({
      host: this.host,
      method: 'POST',
      path: '/goform/goform_set_cmd_process',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: `isTest=false&goformId=LOGIN&password=${pw}`,
    });
    this.extractSessionCookie(res);
    let out;
    try {
      out = JSON.parse(res.body);
    } catch (_) {
      throw new CpeError('Unexpected login response from indoor CPE');
    }
    if (String(out.result) !== '0') {
      const reason = String(out.result) === '3' ? 'bad password' : `result ${out.result}`;
      this.authBlockedUntil = Date.now() + AUTH_BACKOFF_MS;
      throw new CpeAuthError(`Indoor CPE rejected login (${reason})`);
    }
    this.authBlockedUntil = 0;
    return true;
  }

  ensureLogin() {
    if (this.cookie) return Promise.resolve();
    if (this.authBlockedUntil && Date.now() < this.authBlockedUntil) {
      const mins = Math.ceil((this.authBlockedUntil - Date.now()) / 60000);
      throw new CpeAuthError(`Previous login failed — fix CPE_INDOOR_PASSWORD and wait ~${mins} min (retry paused to avoid a 30-minute device lockout)`);
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async getCmd(cmds) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureLogin();
      const q = `isTest=false&cmd=${encodeURIComponent(cmds)}&multi_data=1`;
      const res = await request({
        host: this.host,
        path: `/goform/goform_get_cmd_process?${q}`,
        headers: this.headers(),
      });
      this.extractSessionCookie(res);
      let json;
      try {
        json = JSON.parse(res.body);
      } catch (_) {
        throw new CpeError('Invalid JSON from indoor CPE');
      }
      if (json && String(json.result) === '3' && attempt === 0 && !json.ResponseList) {
        this.cookie = null; // session kicked -> re-login once
        continue;
      }
      return json;
    }
    throw new CpeError('Indoor CPE query failed after re-login');
  }
}

// ---------------------------------------------------------------------------
// OUTDOOR — ubus JSON-RPC client
// ---------------------------------------------------------------------------
class ZteUbusClient {
  constructor(host, password) {
    this.host = host;
    this.password = password;
    this.stok = ANON_SESSION;
    this.nextId = 1;
    this.loginPromise = null;
    // See ZteGoformClient: pause retries after a failed login to avoid lockouts.
    this.authBlockedUntil = 0;
    this.lastFailNum = null;
  }

  async call(object, method, args = {}, { allowRelogin = true } = {}) {
    const payload = [
      { jsonrpc: '2.0', method: 'call', params: [this.stok, object, method, args], id: ++this.nextId },
    ];
    const res = await request({
      host: this.host,
      method: 'POST',
      path: `/ubus/?t=${Date.now()}`,
      headers: { 'Content-Type': 'application/json', Referer: `http://${this.host}/` },
      body: JSON.stringify(payload),
    });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      throw new CpeError('Unexpected response from outdoor CPE');
    }
    const entry = Array.isArray(json) ? json[0] : json;
    if (entry && entry.error && entry.error.code === -32002) {
      if (allowRelogin) {
        this.stok = ANON_SESSION;
        await this.ensureLogin();
        return this.call(object, method, args, { allowRelogin: false });
      }
      const err = new CpeError('Outdoor CPE access denied — login required for this data');
      err.code = 'ACCESS_DENIED';
      throw err;
    }
    if (entry && Array.isArray(entry.result)) {
      // ubus status 6 == PERMISSION_DENIED (e.g. anonymous session calling an
      // auth-required method) — let callers retry after a real login.
      if (entry.result[0] === 6) {
        const err = new CpeError(`Outdoor CPE denied access to ${object}/${method}`);
        err.code = 'ACCESS_DENIED';
        throw err;
      }
      return entry.result; // [status, data]
    }
    throw new CpeError('Outdoor CPE returned an invalid RPC result');
  }

  ensureLogin() {
    if (this.stok !== ANON_SESSION) return Promise.resolve();
    if (this.authBlockedUntil && Date.now() < this.authBlockedUntil) {
      const mins = Math.ceil((this.authBlockedUntil - Date.now()) / 60000);
      throw new CpeAuthError(`Previous login failed — fix CPE_OUTDOOR_PASSWORD and wait ~${mins} min (retry paused to avoid a 30-minute device lockout)`);
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async login() {
    if (!this.password) {
      throw new CpeAuthError('No password configured for the outdoor CPE (set CPE_OUTDOOR_PASSWORD or CPE_ADMIN_PASSWORD in .env)');
    }
    const [, info] = await this.call('zwrt_web', 'web_login_info', {}, { allowRelogin: false });
    if (!info || !info.zte_web_sault) throw new CpeError('Outdoor CPE did not issue a login salt');
    const pw = sha256(sha256(this.password) + info.zte_web_sault);
    const [, out] = await this.call('zwrt_web', 'web_login', { password: pw }, { allowRelogin: false });
    if (String(out && out.result) === '0' && out.ubus_rpc_session) {
      this.stok = out.ubus_rpc_session;
      this.authBlockedUntil = 0;
      this.lastFailNum = null;
      return true;
    }
    this.lastFailNum = out && out.login_fail_num != null ? Number(out.login_fail_num) : null;
    this.authBlockedUntil = Date.now() + AUTH_BACKOFF_MS;
    const left = this.lastFailNum != null ? ` (${this.lastFailNum} attempt(s) left before a 30-min lockout)` : '';
    throw new CpeAuthError(`Outdoor CPE rejected login (bad password)${left}`);
  }
}

module.exports = { ZteGoformClient, ZteUbusClient, CpeAuthError, CpeError, sha256, ANON_SESSION, request };