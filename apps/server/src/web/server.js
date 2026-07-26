const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');

function json(response, status, payload) {
  const body = status === 204 ? '' : JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  response.end(body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        tooLarge = true;
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
    request.on('error', reject);
  });
}

function sendResult(response, result, successStatus = 200) {
  return json(response, result.ok ? successStatus : 400, result);
}

function sendPng(response, filePath) {
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(response);
}

function createWebServer(manager) {
  const config = manager.config;
  const staticDir = path.resolve(config.rootDir, 'apps/web/dist');
  return http.createServer(async (request, response) => {
    if (request.method === 'OPTIONS') return json(response, 204, {});
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, { ok: true, service: 'mc-bot-self', time: new Date().toISOString() });
      }
      const skinMatch = pathname.match(/^\/api\/skins\/([^/]+)\/(avatar|body)$/);
      if (skinMatch && request.method === 'GET') {
        const id = decodeURIComponent(skinMatch[1]);
        const kind = skinMatch[2];
        await manager.ensureSkin(id);
        const filePath = manager.skinFile(id, kind);
        return filePath ? sendPng(response, filePath) : json(response, 404, { ok: false, message: `No cached skin is available for ${id}. Set a Minecraft skin username or start the bot once.` });
      }
      if (pathname === '/api/bots' && request.method === 'GET') return json(response, 200, { bots: manager.list() });
      if (pathname === '/api/bots' && request.method === 'POST') {
        return sendResult(response, manager.add(await parseBody(request)), 201);
      }
      if (pathname === '/api/config' && request.method === 'GET') {
        return json(response, 200, {
          bots: manager.definitions(),
          web: {
            host: manager.config.web.host,
            port: manager.config.web.port,
            viewerPortStart: manager.config.web.viewerPortStart,
            allowRawCommands: manager.config.web.allowRawCommands
          },
          defaults: { skills: manager.config.defaults.skills },
          skills: manager.skillSettings(),
          workflows: manager.workflows()
        });
      }
      if (pathname === '/api/skills' && request.method === 'GET') return json(response, 200, manager.skillSettings());
      if (pathname === '/api/skills' && request.method === 'PUT') {
        const body = await parseBody(request);
        return sendResult(response, manager.updateSkills(body.scope, body.botId, body.skills));
      }
      if (pathname === '/api/skills/copy' && request.method === 'POST') {
        const body = await parseBody(request);
        return sendResult(response, manager.copySkills(body.sourceBotId, Array.isArray(body.targetBotIds) ? body.targetBotIds : []));
      }

      if (pathname === '/api/workflows' && request.method === 'GET') return json(response, 200, { workflows: manager.workflows() });
      if (pathname === '/api/workflow-nodes' && request.method === 'GET') return json(response, 200, { nodes: manager.workflowNodeTypes() });
      if (pathname === '/api/workflows' && request.method === 'PUT') {
        const body = await parseBody(request);
        return sendResult(response, manager.updateWorkflows(body.workflows));
      }

      if (pathname === '/api/whitelist' && request.method === 'GET') {
        const botId = url.searchParams.get('botId');
        const runtime = botId ? manager.get(botId) : null;
        if (botId && !runtime) return json(response, 404, { ok: false, message: `Unknown bot: ${botId}` });
        return json(response, 200, { whitelist: runtime && Array.isArray(runtime.definition.commandWhitelist) ? runtime.definition.commandWhitelist : manager.config.whitelist });
      }
      if (pathname === '/api/whitelist' && request.method === 'PUT') {
        const body = await parseBody(request);
        return sendResult(response, manager.setWhitelist(body.whitelist, body.botId || null));
      }
      if (pathname === '/api/logs' && request.method === 'GET') {
        return json(response, 200, { logs: manager.recentLogs(url.searchParams.get('botId'), url.searchParams.get('limit')) });
      }
      if (pathname === '/api/batch' && request.method === 'POST') {
        const body = await parseBody(request);
        return json(response, 200, manager.batch(body.action, Array.isArray(body.ids) ? body.ids : []));
      }

      const match = pathname.match(/^\/api\/bots\/([^/]+)(?:\/(start|stop|restart|command|perspective|region|supply|home-targets|home-set|workflow))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const action = match[2];
        if (!action && request.method === 'GET') {
          const definition = manager.definition(id);
          return definition ? json(response, 200, { definition }) : json(response, 404, { ok: false, message: `Unknown bot: ${id}` });
        }
        if (!action && request.method === 'PUT') return sendResult(response, manager.update(id, await parseBody(request)));
        if (!action && request.method === 'DELETE') return sendResult(response, manager.remove(id));
        if (request.method === 'POST' && action === 'start') return sendResult(response, manager.start(id));
        if (request.method === 'POST' && action === 'stop') return sendResult(response, manager.stop(id));
        if (request.method === 'POST' && action === 'restart') return sendResult(response, manager.restart(id));
        if (request.method === 'POST' && action === 'perspective') {
          const body = await parseBody(request);
          return sendResult(response, manager.setViewerPerspective(id, body.firstPerson));
        }
        if (request.method === 'PUT' && action === 'region') {
          return sendResult(response, manager.configureRegion(id, await parseBody(request)));
        }
        if (request.method === 'PUT' && action === 'supply') {
          const body = await parseBody(request);
          return sendResult(response, manager.configureSupply(id, body.points));
        }
        if (request.method === 'PUT' && action === 'home-targets') {
          const body = await parseBody(request);
          return sendResult(response, manager.configureHomeTargets(id, body.targets));
        }
        if (request.method === 'POST' && action === 'home-set') {
          const body = await parseBody(request);
          return sendResult(response, await manager.setHomeTarget(id, body.targetId || body.name));
        }
        if (request.method === 'POST' && action === 'workflow') {
          const body = await parseBody(request);
          return sendResult(response, await manager.runWorkflow(id, body.workflowId || body.id, body.input || {}));
        }
        if (request.method === 'POST' && action === 'command') {
          const body = await parseBody(request);
          const result = body.command ? manager.executeLine(id, body.command, 'web') : { ok: false, message: 'Missing command.' };
          return sendResult(response, result);
        }
      }

      if (!pathname.startsWith('/api/')) return serveStatic(response, staticDir, pathname);
      return json(response, 404, { ok: false, message: 'Not found.' });
    } catch (error) {
      return json(response, 500, { ok: false, message: error.message });
    }
  });
}

function serveStatic(response, rootDir, pathname) {
  let requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let filePath = path.resolve(rootDir, requested);
  if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    requested = 'index.html';
    filePath = path.resolve(rootDir, requested);
  }
  if (!fs.existsSync(filePath)) {
    return json(response, 404, { ok: false, message: 'Web UI is not built. Run `pixi run build` first.' });
  }
  const contentType = requested.endsWith('.html') ? 'text/html; charset=utf-8'
    : requested.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : requested.endsWith('.css') ? 'text/css; charset=utf-8'
        : requested.endsWith('.svg') ? 'image/svg+xml'
          : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(response);
}

function startWebServer(manager) {
  const server = createWebServer(manager);
  const { host, port } = manager.config.web;
  server.listen(port, host, () => console.log(`Control server listening on http://${host}:${port}`));
  return server;
}

module.exports = { createWebServer, startWebServer };
