import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Office } from './office.ts';
import { startWatcher } from './watcher.ts';
import { StatsAggregator } from './stats.ts';
import { CharacterStore, sanitizeId, isAnimSlot, saveUpload, streamFile } from './characters.ts';
import { DecorStore, isWallArtExt, wallArtContentType } from './decor.ts';
import { Quiz, type QuizAsker } from './quiz.ts';
import { askHaiku } from './haiku.ts';
import type { QuizWinner } from '../../shared/types.ts';

const PORT = 4680;
/** ~8k chars is the recommended bio size; hard cap leaves generous headroom */
const BIO_MAX_CHARS = 20_000;
/** How often we sample headcount / persist+broadcast dirty stats. */
const STATS_INTERVAL_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.resolve(__dirname, '../../data/usage.json');

const characters = new CharacterStore();
const decor = new DecorStore();
const office = new Office(() => characters.variantIds());
const stats = new StatsAggregator(STATS_FILE);

/**
 * Candidate questioners for the 20 Questions game: every employee, the boss, and
 * Kat Person (who is furniture, not staff — she has no roster entry, so she is
 * named here). Idle staff are preferred by the Quiz itself.
 */
const quizAskers = (): QuizAsker[] => {
  const st = office.getState();
  return [
    { id: 'boss', name: st.boss.name, variant: st.boss.variant, idle: st.bossStatus === 'idle' },
    ...st.employees.map((e) => ({ id: e.id, name: e.name, variant: e.variant, idle: e.status === 'idle' })),
    { id: 'catPerson', name: 'Kat Person', variant: 'CatPerson', idle: true },
  ];
};

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
      // the painting and the Employee of the Month photo are both wall hangings:
      // resetting the room restores the built-in art and takes the photo down
      decor.clearWallArt();
      decor.clearEotm();
      office.resetLayout();
      quiz.clearPhoto();
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/decor/wallart') {
      if (req.method === 'GET') {
        const art = office.getState().wallArt;
        if (!art || !streamFile(decor.wallArtPath(art.ext), res, wallArtContentType(art.ext), 'public, max-age=31536000, immutable')) {
          return send(404, { error: 'no custom wall art' });
        }
        return;
      }
      if (req.method === 'POST') {
        const ext = (url.searchParams.get('ext') ?? '').toLowerCase();
        if (!isWallArtExt(ext)) return send(400, { error: 'ext must be png, jpg or webp' });
        const result = await saveUpload(req, decor.wallArtPath(ext), 'image');
        if (!result.ok) return send(400, { error: result.error });
        decor.clearWallArt(ext); // one painting at a time, whatever the previous format was
        // a fresh upload resets the framing; `v` busts the immutable cache entry
        office.setWallArt({ v: Date.now(), ext, zoom: 1, panX: 0 });
        return send(200, { ok: true, wallArt: office.getState().wallArt });
      }
      if (req.method === 'PUT') {
        const body = await readBody();
        if (!office.getState().wallArt) return send(404, { error: 'no custom wall art' });
        office.setWallArt({ zoom: body?.zoom, panX: body?.panX });
        return send(200, { ok: true, wallArt: office.getState().wallArt });
      }
      if (req.method === 'DELETE') {
        decor.clearWallArt();
        office.clearWallArt();
        return send(200, { ok: true });
      }
    }
    if (url.pathname === '/api/quiz' && req.method === 'PUT') {
      const body = await readBody();
      if (typeof body.enabled !== 'boolean') return send(400, { error: 'enabled must be a boolean' });
      quiz.setEnabled(body.enabled);
      return send(200, { ok: true, quiz: quiz.getState() });
    }
    if (url.pathname === '/api/quiz/answer' && req.method === 'POST') {
      const body = await readBody();
      if (typeof body.id !== 'string' || (body.answer !== 'yes' && body.answer !== 'no')) {
        return send(400, { error: 'need { id: string, answer: "yes" | "no" }' });
      }
      const result = quiz.answer(body.id, body.answer);
      // a stale id means another tab already answered this bubble
      return result === 'ok' ? send(200, { ok: true }) : send(409, { error: 'that question is no longer open' });
    }
    if (url.pathname === '/api/decor/eotm') {
      if (req.method === 'GET') {
        const photo = quiz.getState().photo;
        if (!photo || !streamFile(decor.eotmPath(), res, 'image/png', 'public, max-age=31536000, immutable')) {
          return send(404, { error: 'no employee of the month yet' });
        }
        return;
      }
      if (req.method === 'POST') {
        // only accepted during the handshake window, so a stray POST can't hang a photo
        if (!quiz.isAwaitingPhoto()) return send(409, { error: 'not waiting for a photo' });
        const result = await saveUpload(req, decor.eotmPath(), 'image');
        if (!result.ok) return send(400, { error: result.error });
        return quiz.attachPhoto() ? send(200, { ok: true }) : send(409, { error: 'not waiting for a photo' });
      }
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

/**
 * Ask exactly ONE client to photograph the winner. Assigned rather than elected:
 * a dozen open tabs would otherwise each fly their camera and upload a shot.
 * If that client is gone or its capture fails, the Quiz's photo timeout takes
 * over and the win is credited without a new photo.
 */
const requestPhotoCapture = (winner: QuizWinner) => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify({ type: 'quiz', quiz: quiz.getState(), capture: winner }));
    return;
  }
};

const quiz = new Quiz({
  ask: askHaiku,
  emit: (msg) => broadcast(msg),
  requestCapture: (winner) => requestPhotoCapture(winner),
  status: (text) => office.pushStatus('quiz', text),
  recordWin: (name) => {
    stats.recordGameWin(name);
    stats.flush();
    broadcast({ type: 'stats', stats: stats.snapshot() });
  },
  askers: quizAskers,
});

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'state', state: office.getState() }));
  for (const msg of office.screenReplay()) ws.send(JSON.stringify(msg));
  ws.send(JSON.stringify({ type: 'stats', stats: stats.snapshot() }));
  ws.send(JSON.stringify({ type: 'quiz', quiz: quiz.getState() }));
});

office.subscribe((msg) => broadcast(msg));

startWatcher(office, stats);

setInterval(() => {
  stats.recordHeadcount(office.getState().employees.length);
  if (stats.isDirty()) {
    stats.flush();
    broadcast({ type: 'stats', stats: stats.snapshot() });
  }
}, STATS_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`thisoffice server on http://localhost:${PORT}`);
});
