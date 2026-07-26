import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Office } from './office.ts';
import { startWatcher } from './watcher.ts';
import { StatsAggregator } from './stats.ts';
import { CharacterStore, sanitizeId, isAnimSlot, saveUpload, streamFile } from './characters.ts';

const PORT = 4680;
/** ~8k chars is the recommended bio size; hard cap leaves generous headroom */
const BIO_MAX_CHARS = 20_000;
/** How often we sample headcount / persist+broadcast dirty stats. */
const STATS_INTERVAL_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.resolve(__dirname, '../../data/usage.json');

const characters = new CharacterStore();
const office = new Office(() => characters.variantIds());
const stats = new StatsAggregator(STATS_FILE);

/** Push the merged catalog to every client and refresh the hiring pool. */
const publishCatalog = () => {
  office.setVariantPool(characters.variantIds());
  office.emitCatalog(characters.mergedCatalog());
};

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
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      return send(200, characters.mergedCatalog());
    }
    if (url.pathname === '/api/anims' && req.method === 'GET') {
      return send(200, characters.animStatus());
    }
    const animMatch = url.pathname.match(/^\/api\/anims\/([a-z]+)$/);
    if (animMatch) {
      const slot = animMatch[1];
      if (!isAnimSlot(slot)) return send(404, { error: 'unknown animation slot' });
      if (req.method === 'POST') {
        const result = await saveUpload(req, characters.animPath(slot), 'fbx');
        return result.ok ? send(200, { ok: true }) : send(400, { error: result.error });
      }
      if (req.method === 'GET') {
        if (!streamFile(characters.animPath(slot), res, 'application/octet-stream')) {
          return send(404, { error: 'animation not uploaded yet' });
        }
        return;
      }
    }
    const charModelMatch = url.pathname.match(/^\/api\/characters\/([^/]+)\/model\.glb$/);
    if (charModelMatch && req.method === 'GET') {
      const id = sanitizeId(charModelMatch[1]);
      if (!id) return send(400, { error: 'bad character id' });
      if (!streamFile(characters.modelPath(id), res, 'model/gltf-binary', 'public, max-age=31536000, immutable')) {
        return send(404, { error: 'character not found' });
      }
      return;
    }
    const charMatch = url.pathname.match(/^\/api\/characters\/([^/]+)$/);
    if (charMatch && req.method === 'POST') {
      const id = sanitizeId(charMatch[1]);
      if (!id) return send(400, { error: 'bad character id' });
      if (characters.isBuiltinId(id)) {
        return send(409, { error: `"${id}" is a built-in character — pick another name` });
      }
      const result = await saveUpload(req, characters.modelPath(id), 'glb');
      if (!result.ok) return send(400, { error: result.error });
      characters.register(id, url.searchParams.get('displayName') || id.replace(/_/g, ' '));
      publishCatalog();
      return send(200, { ok: true, id });
    }
    if (charMatch && req.method === 'PATCH') {
      const id = sanitizeId(charMatch[1]);
      if (!id) return send(400, { error: 'bad character id' });
      const body = await readBody();
      const patch: { scale?: number; seatOffset?: number; chairHeight?: number; chairForward?: number } = {};
      for (const f of ['scale', 'seatOffset', 'chairHeight', 'chairForward'] as const) {
        if (typeof body?.[f] === 'number' && Number.isFinite(body[f])) patch[f] = body[f];
      }
      if (Object.keys(patch).length === 0) {
        return send(400, { error: 'need at least one finite number: scale, seatOffset, chairHeight, chairForward' });
      }
      // builtins are never in the imported list, so adjust 404s them too
      if (!characters.adjust(id, patch)) {
        return send(404, { error: 'not an imported character' });
      }
      publishCatalog();
      return send(200, { ok: true });
    }
    if (charMatch && req.method === 'DELETE') {
      const id = sanitizeId(charMatch[1]);
      const ok = !!id && characters.remove(id);
      if (ok) publishCatalog();
      return send(ok ? 200 : 404, { ok });
    }
    if (url.pathname === '/api/boss/bio') {
      if (req.method === 'GET') return send(200, { bio: office.getBossBio() });
      if (req.method === 'PUT') {
        const body = await readBody();
        if (typeof body.bio !== 'string' || body.bio.length > BIO_MAX_CHARS) {
          return send(400, { error: `bio must be a string of at most ${BIO_MAX_CHARS} chars` });
        }
        office.setBossBio(body.bio);
        return send(200, { ok: true });
      }
    }
    const bioMatch = url.pathname.match(/^\/api\/employees\/([^/]+)\/bio$/);
    if (bioMatch) {
      if (req.method === 'GET') {
        const bio = office.getEmployeeBio(bioMatch[1]);
        return bio === null ? send(404, { error: 'no such employee' }) : send(200, { bio });
      }
      if (req.method === 'PUT') {
        const body = await readBody();
        if (typeof body.bio !== 'string' || body.bio.length > BIO_MAX_CHARS) {
          return send(400, { error: `bio must be a string of at most ${BIO_MAX_CHARS} chars` });
        }
        return office.setEmployeeBio(bioMatch[1], body.bio)
          ? send(200, { ok: true })
          : send(404, { error: 'no such employee' });
      }
    }
    if (url.pathname === '/api/office' && req.method === 'PUT') {
      const body = await readBody();
      if (typeof body.name !== 'string') return send(400, { error: 'name must be a string' });
      office.setOfficeName(body.name);
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readBody();
      office.setBoss({ name: body.name, variant: body.variant });
      if (body.staffing) office.setStaffing(body.staffing);
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/layout' && req.method === 'PUT') {
      const body = await readBody();
      office.setLayout(body); // mergeLayout sanitizes; garbage keys are dropped
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/layout' && req.method === 'DELETE') {
      office.resetLayout();
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/employees' && req.method === 'POST') {
      return send(200, { ok: true, employee: office.hireManual() });
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

const broadcast = (msg: unknown) => {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
};

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'state', state: office.getState() }));
  for (const msg of office.screenReplay()) ws.send(JSON.stringify(msg));
  ws.send(JSON.stringify({ type: 'stats', stats: stats.snapshot() }));
});

office.subscribe((msg) => broadcast(msg));

startWatcher(office, stats);

// No clean hook into Office's hire path is reachable from here (hire() is
// private and assign()/hireManual() aren't instrumented), so hires are
// inferred from headcount deltas on the same cadence as the headcount sample.
let lastHeadcount = office.getState().employees.length;
setInterval(() => {
  const headcount = office.getState().employees.length;
  if (headcount > lastHeadcount) {
    for (let i = 0; i < headcount - lastHeadcount; i++) stats.recordHire();
  }
  lastHeadcount = headcount;
  stats.recordHeadcount(headcount);
  if (stats.isDirty()) {
    stats.flush();
    broadcast({ type: 'stats', stats: stats.snapshot() });
  }
}, STATS_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`thisoffice server on http://localhost:${PORT}`);
});
