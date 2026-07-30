'use strict';
const http = require('http');
const https = require('https');

/**
 * Stores original agents/dispatchers so they can be restored after auth completes.
 */
const saved = {
  httpAgent: null,
  httpsAgent: null,
  undiciDispatcher: null
};

/**
 * Create an undici-compatible Agent that routes all traffic through a SOCKS5 proxy.
 *
 * undici v8 wraps custom connect as: connect = (opts, cb) => customConnect({...opts}, cb)
 * It expects callback-style, NOT async/Promise-based.
 */
function buildSocks5Dispatcher(proxyUrl) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const { Agent } = require('undici');

  const socksAgent = new SocksProxyAgent(proxyUrl);

  return new Agent({
    connect(origin, callback) {
      socksAgent
        .connect(
          { emit: () => {}, destroy: () => {}, url: '', method: 'CONNECT' },
          {
            host: origin.hostname || origin.host,
            port: parseInt(origin.port || '443', 10),
            secureEndpoint: origin.protocol === 'https:',
          }
        )
        .then((socket) => callback(null, socket))
        .catch((err) => callback(err, null));
    },
  });
}

/**
 * Activate auth proxy for HTTP(S) requests used during Microsoft/Mojang login.
 *
 * Only supports SOCKS5 proxies (e.g. socks5://127.0.0.1:1080).
 * The raw TCP connection to the Minecraft server is NOT affected.
 *
 * @param {string} proxyUrl  e.g. "socks5://127.0.0.1:1080"
 */
async function activateAuthProxy(proxyUrl) {
  if (!proxyUrl) return;

  const protocol = proxyUrl.split(':')[0].toLowerCase();
  if (protocol !== 'socks5' && protocol !== 'socks5h') {
    console.warn(`[auth-proxy] Unsupported protocol "${protocol}" — only socks5/socks5h is supported`);
    return;
  }

  // 1) Replace undici global dispatcher – this is what Node's built-in
  //    fetch() uses under the hood (undici is the engine behind fetch()).
  const undici = require('undici');
  saved.undiciDispatcher = undici.getGlobalDispatcher();
  undici.setGlobalDispatcher(buildSocks5Dispatcher(proxyUrl));

  // 2) Also patch http.Agent / https.Agent as a fallback for any callers that
  //    still use http.request() (e.g. older yggdrasil flows).
  saved.httpAgent = http.globalAgent;
  saved.httpsAgent = https.globalAgent;

  const { SocksProxyAgent } = require('socks-proxy-agent');
  const legacyAgent = new SocksProxyAgent(proxyUrl);
  http.globalAgent = legacyAgent;
  https.globalAgent = legacyAgent;

  console.log(`[auth-proxy] Activated SOCKS5 proxy via undici + http.Agent: ${proxyUrl}`);
}

/**
 * Restore original global agents/dispatchers after auth completes.
 */
function deactivateAuthProxy() {
  if (saved.httpAgent) {
    http.globalAgent = saved.httpAgent;
    saved.httpAgent = null;
  }
  if (saved.httpsAgent) {
    https.globalAgent = saved.httpsAgent;
    saved.httpsAgent = null;
  }
  if (saved.undiciDispatcher) {
    try {
      const undici = require('undici');
      undici.setGlobalDispatcher(saved.undiciDispatcher);
    } catch {
      // undici not available – nothing to restore
    }
    saved.undiciDispatcher = null;
  }
}

module.exports = { activateAuthProxy, deactivateAuthProxy };