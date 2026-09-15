const { ZteGoformClient, ZteUbusClient, CpeAuthError, CpeError } = require('./zteClient');

// Centralized live-CPE service. Both gateways are managed from one page (/cpe);
// the app logs into each device server-side and pulls real state:
//
//   indoor  (Airtel Smart Hub, goform API)  -> connected device list + MAC block list
//   outdoor (ZTE MC8830, ubus JSON-RPC)     -> signal (RSRP/RSRQ/SINR/RSSI),
//                                              live upload/download throughput, reboot
//
// Login state is cached per client; auth failures surface as CpeAuthError so the
// page can show a precise "wrong password" state instead of a generic error.

const indoor = new ZteGoformClient(
  process.env.CPE_INDOOR_HOST || '192.168.18.1',
  process.env.CPE_INDOOR_PASSWORD || process.env.CPE_ADMIN_PASSWORD || ''
);
const outdoor = new ZteUbusClient(
  process.env.CPE_OUTDOOR_HOST || '192.168.254.1',
  process.env.CPE_OUTDOOR_PASSWORD || process.env.CPE_ADMIN_PASSWORD || ''
);

// Wraps a promise so any failure degrades to an error field instead of blowing
// up the whole response (one CPE being down must not blank the other's data).
async function guard(promiseFactory) {
  try {
    return { data: await promiseFactory(), error: null };
  } catch (err) {
    return {
      data: null,
      error: {
        code: err.code || 'CPE_ERROR',
        auth: err instanceof CpeAuthError,
        message: err instanceof CpeError || err instanceof CpeAuthError ? err.message : 'Unexpected CPE error',
      },
    };
  }
}

// INDOOR: stations + MAC block list in one authenticated batch.
async function fetchIndoorData() {
  const [stations, acl] = await Promise.all([
    indoor.getCmd('queryStationList'),
    indoor.getCmd('ACL_mode,wifi_mac_black_list,wifi_hostname_black_list'),
  ]);
  const hosts = [];
  const responseList = stations && Array.isArray(stations.ResponseList) ? stations.ResponseList : [];
  for (const chip of responseList) {
    for (const h of chip.HostList || []) {
      hosts.push({ mac: h.MAC, name: h.HostName || '', ip: h.IpAddress || '' });
    }
  }
  const blackList = String((acl && acl.wifi_mac_black_list) || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    hosts,
    aclMode: acl ? String(acl.ACL_mode || '') : '',
    blackList,
  };
}

// OUTDOOR: signal is readable with the anonymous session on the MC8830, so it
// always works; throughput (get_wwandst) requires a login, and degrades to null
// when credentials are wrong — one bad password must not blind the whole panel.
async function callOutdoorData(object, method, args = {}) {
  const run = () => outdoor.call(object, method, args, { allowRelogin: false });
  const unwrap = (r) => {
    if (!Array.isArray(r) || r.length < 2 || r[0] !== 0) {
      throw new CpeError(`Outdoor CPE rejected ${object}/${method} (status ${Array.isArray(r) ? r[0] : 'n/a'})`);
    }
    return r[1];
  };
  try {
    return unwrap(await run());
  } catch (err) {
    if (err.code !== 'ACCESS_DENIED') throw err;
    await outdoor.ensureLogin(); // may throw CpeAuthError -> surfaced as auth state
    return unwrap(await run());
  }
}

async function fetchOutdoorData() {
  // - signal:      zte_nwinfo_api/nwinfo_get_netinfo (lte_rsrp/rsrq/snr/rssi, signalbar...)
  // - throughput:  zwrt_data/get_wwandst {source_module:"web",cid:1,type:4} — the exact
  //   call the MC8830 dashboard loop uses; real_rx_speed = download, real_tx_speed = upload.
  const [net, thrpt] = await Promise.all([
    callOutdoorData('zte_nwinfo_api', 'nwinfo_get_netinfo'),
    callOutdoorData('zwrt_data', 'get_wwandst', { source_module: 'web', cid: 1, type: 4 }).catch(() => null),
  ]);
  return { net, thrpt };
}

// Full snapshot for the /cpe page and its poll endpoint.
async function getCpeStatus() {
  const checkedAt = new Date().toISOString();
  const [indoorRes, outdoorRes] = await Promise.all([
    guard(fetchIndoorData),
    guard(fetchOutdoorData),
  ]);

  const i = indoorRes.data;
  const o = outdoorRes.data;

  return {
    checkedAt,
    indoor: {
      host: process.env.CPE_INDOOR_HOST || '192.168.18.1',
      url: `http://${process.env.CPE_INDOOR_HOST || '192.168.18.1'}`,
      online: !indoorRes.error,
      error: indoorRes.error,
      stations: i ? i.hosts : [],
      aclMode: i ? i.aclMode : '',
      blackList: i ? i.blackList : [],
    },
    outdoor: {
      host: process.env.CPE_OUTDOOR_HOST || '192.168.254.1',
      url: `http://${process.env.CPE_OUTDOOR_HOST || '192.168.254.1'}`,
      online: !outdoorRes.error,
      error: outdoorRes.error,
      signal: o
        ? {
            networkType: o.net.network_type || '',
            signalBar: o.net.signalbar,
            rsrp: o.net.lte_rsrp,
            rsrq: o.net.lte_rsrq,
            sinr: o.net.lte_snr,
            rssi: o.net.lte_rssi,
            band: o.net.wan_active_channel || o.net.bandwidth || '',
            cellId: o.net.cell_id || '',
          }
        : null,
      throughput: o && o.thrpt
        ? {
            // real_*_speed is bytes/sec on the MC8830 dashboard loop; normalize to Mbps.
            downloadMbps: Number(o.thrpt.real_rx_speed || 0) / 1e6,
            uploadMbps: Number(o.thrpt.real_tx_speed || 0) / 1e6,
            rxBytes: Number(o.thrpt.real_rx_bytes || 0),
            txBytes: Number(o.thrpt.real_tx_bytes || 0),
          }
        : null,
    },
  };
}

// OUTDOOR: restart command (zwrt_mc.device.manager/device_reboot).
async function rebootOutdoor() {
  await outdoor.ensureLogin();
  const result = await outdoor.call('zwrt_mc.device.manager', 'device_reboot', {
    moduleName: 'web',
  });
  // ubus status 0 == accepted.
  if (Array.isArray(result) && result[0] !== 0) {
    throw new CpeError(`Outdoor CPE rejected reboot (status ${result[0]})`);
  }
  return true;
}

module.exports = { getCpeStatus, rebootOutdoor };