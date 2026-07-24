import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Office } from './office.ts';
import { startWatcher } from './watcher.ts';

const PORT = 4680;

const office = new Office();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (): Promise<any> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  (async () => {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(200, office.getState());
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readBody();
      office.setBoss({ name: body.name, variant: body.variant });
      return send(200, { ok: true });
    }
    const empMatch = url.pathname.match(/^\/api\/employees\/([^/]+)$/);
    if (empMatch && req.method === 'PUT') {
      const body = await readBody();
      let ok = true;
      if (typeof body.name === 'string') ok = office.rename(empMatch[1], body.name) && ok;
      if (typeof body.variant === 'string') ok = office.setVariant(empMatch[1], body.variant) && ok;
      return send(ok ? 200 : 404, { ok });
    }
    if (empMatch && req.method === 'DELETE') {
      const ok = office.remove(empMatch[1]);
      return send(ok ? 200 : 404, { ok });
    }
    send(404, { error: 'not found' });
  })().catch((e) => send(500, { error: String(e) }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'state', state: office.getState() }));
});

office.subscribe((msg) => {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
});

startWatcher(office);

server.listen(PORT, () => {
  console.log(`thisoffice server on http://localhost:${PORT}`);
});
