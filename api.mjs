const AUTH = 'https://auth.riotgames.com/api/v1/authorization';
const UA = 'RiotClient/63.0.9.4909983.4789131 rso-auth (Windows;10;;Professional, x64)';
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';

class Jar {
  constructor(c = {}) { this.c = c; }
  add(res) {
    for (const s of res.headers.getSetCookie()) {
      const kv = s.split(';')[0], i = kv.indexOf('=');
      this.c[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
  }
  header() { return Object.entries(this.c).map(([k, v]) => k + '=' + v).join('; '); }
}

async function rq(jar, url, method, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Cookie: jar.header(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.add(res);
  const t = await res.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { res, j, t };
}

async function start(username, password) {
  if (!username || !password) throw new Error('preencha usuário e senha');
  const jar = new Jar();
  await rq(jar, AUTH, 'POST', {}, {
    client_id: 'play-valorant-web-prod', nonce: '1',
    redirect_uri: 'https://playvalorant.com/opt_in',
    response_type: 'token id_token', scope: 'account openid',
  });
  const r = await rq(jar, AUTH, 'PUT', {}, { type: 'auth', username, password, remember: false, language: 'en_US' });
  return next(jar, r);
}

async function next(jar, r) {
  const j = r.j;
  if (!j) throw new Error('resposta inválida da Riot (HTTP ' + r.res.status + '), provavelmente bloqueio do Cloudflare');
  if (j.type === 'response') return finish(jar, j.response.parameters.uri);
  if (j.type === 'multifactor') return { status: 'mfa', jar: jar.c, email: j.multifactor?.email || '' };
  if (j.error === 'auth_failure') throw new Error('usuário ou senha incorretos');
  if (j.error === 'rate_limited') throw new Error('muitas tentativas, espere uns minutos');
  throw new Error('login recusado: ' + (j.error || j.type || 'desconhecido'));
}

async function finish(jar, uri) {
  const p = new URLSearchParams(new URL(uri).hash.slice(1));
  const at = p.get('access_token'), idt = p.get('id_token');
  const A = { Authorization: 'Bearer ' + at };

  const ent = (await rq(jar, 'https://entitlements.auth.riotgames.com/api/token/v1', 'POST', A, {})).j?.entitlements_token;
  const puuid = (await rq(jar, 'https://auth.riotgames.com/userinfo', 'POST', A, {})).j?.sub;
  const geo = (await rq(jar, 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant', 'PUT', A, { id_token: idt })).j;
  if (!ent || !puuid || !geo?.affinities) throw new Error('não consegui obter os tokens da conta');

  const region = geo.affinities.live;
  const shard = ['latam', 'br'].includes(region) ? 'na' : region;
  const ver = (await (await fetch('https://valorant-api.com/v1/version')).json()).data.riotClientVersion;
  const plat = Buffer.from(JSON.stringify({
    platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown',
  })).toString('base64');

  const sf = (await rq(jar, `https://pd.${shard}.a.pvp.net/store/v2/storefront/${puuid}`, 'GET', {
    ...A, 'X-Riot-Entitlements-JWT': ent, 'X-Riot-ClientPlatform': plat, 'X-Riot-ClientVersion': ver,
  }, null)).j;
  const lay = sf?.SkinsPanelLayout;
  if (!lay) throw new Error('loja indisponível: ' + JSON.stringify(sf).slice(0, 140));

  const price = {};
  (lay.SingleItemStoreOffers || []).forEach(o => { price[o.OfferID] = o.Cost?.[VP] ?? Object.values(o.Cost || {})[0]; });
  return {
    status: 'ok',
    region,
    remaining: lay.SingleItemOffersRemainingDurationInSeconds,
    offers: lay.SingleItemOffers.map(id => ({ id, cost: price[id] ?? null })),
  };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  try {
    const p = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    if (p === '/api/login') return Response.json(await start(b.username, b.password));
    if (p === '/api/mfa') {
      const jar = new Jar(b.jar || {});
      const r = await rq(jar, AUTH, 'PUT', {}, { type: 'multifactor', code: String(b.code || ''), rememberDevice: false });
      return Response.json(await next(jar, r));
    }
    return new Response(null, { status: 404 });
  } catch (e) {
    return Response.json({ error: e.message });
  }
};

export const config = { path: ['/api/login', '/api/mfa'] };
