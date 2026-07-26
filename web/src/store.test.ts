import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeState, QuizState, UsageStats } from '../../shared/types.ts';
import {
  enterFocusMode,
  resetInboxKeyForTest,
  resetStatusKeyForTest,
  resetTvStatsKeyForTest,
  resetWhiteboardKeyForTest,
  parseCameraMode,
  shouldExitFocusOnMissedClick,
  toPersistedCameraMode,
  useStore,
  type CameraMode,
  type CameraPose,
} from './store.ts';

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [],
    inbox: [],
    todos: null,
    status: [],
    staffing: { minEmployees: 0, maxEmployees: 9, idleTimeoutSec: 60 },
    ...overrides,
  } as OfficeState;
}

describe('monitor history', () => {
  beforeEach(() => {
    useStore.setState({
      monitors: {},
      monitorVersion: {},
      monitorHistory: {},
      lastActivity: {},
      cameraMode: { kind: 'free' },
      focusScroll: 0,
    });
  });

  it('survives clear messages, marking the boundary with a divider', () => {
    const apply = useStore.getState().applyServerMsg;
    apply({ type: 'monitor', target: 'e1', append: 'a\nb' } as never);
    apply({ type: 'monitor', target: 'e1', clear: true, title: 'Bash · proj' } as never);
    apply({ type: 'monitor', target: 'e1', append: 'c' } as never);

    expect(useStore.getState().monitors['e1'].lines).toEqual(['c']);
    expect(useStore.getState().monitorHistory['e1']).toEqual(['a', 'b', '── Bash · proj ──', 'c']);
  });

  it('keeps image marker lines out of history', () => {
    const apply = useStore.getState().applyServerMsg;
    apply({ type: 'monitor', target: 'e1', append: 'a\n⟦IMG⟧data:image/png;base64,xyz' } as never);
    expect(useStore.getState().monitorHistory['e1']).toEqual(['a']);
  });

  it('snaps back to the live tail when leaving focus mode', () => {
    useStore.setState({
      cameraMode: { kind: 'focus', target: 'e1', from: { kind: 'free' } },
      focusScroll: 42,
    });
    useStore.getState().setCameraMode({ kind: 'free' });
    expect(useStore.getState().focusScroll).toBe(0);
  });

  it('resets focusScroll when entering focus mode', () => {
    useStore.setState({ focusScroll: 42 });
    useStore.getState().setCameraMode({ kind: 'focus', target: 'e1', from: { kind: 'free' } });
    expect(useStore.getState().focusScroll).toBe(0);
    expect(useStore.getState().cameraMode).toEqual({ kind: 'focus', target: 'e1', from: { kind: 'free' } });
  });
});

describe('enterFocusMode', () => {
  const pose: CameraPose = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] };

  it('remembers the free-camera pose so exit can fly back to it', () => {
    expect(enterFocusMode({ kind: 'free' }, 'e1', pose)).toEqual({
      kind: 'focus',
      target: 'e1',
      from: { kind: 'free' },
      returnPose: pose,
    });
  });

  it('does not keep a pose when entering from pov or movie (they reposition themselves)', () => {
    expect(enterFocusMode({ kind: 'movie' }, 'e1', pose)).toEqual({
      kind: 'focus',
      target: 'e1',
      from: { kind: 'movie' },
      returnPose: undefined,
    });
  });

  it('carries the original from-mode and pose when switching monitors', () => {
    const first = enterFocusMode({ kind: 'free' }, 'e1', pose);
    const other: CameraPose = { position: [9, 9, 9], quaternion: [0, 1, 0, 0] };
    expect(enterFocusMode(first, 'e2', other)).toEqual({
      kind: 'focus',
      target: 'e2',
      from: { kind: 'free' },
      returnPose: pose,
    });
  });

  it('records that entry came from a pointer-locked first person and keeps it across monitor switches', () => {
    const first = enterFocusMode({ kind: 'free' }, 'e1', pose, true);
    expect(first).toMatchObject({ kind: 'focus', target: 'e1', relock: true });
    const other: CameraPose = { position: [9, 9, 9], quaternion: [0, 1, 0, 0] };
    expect(enterFocusMode(first, 'e2', other)).toMatchObject({ target: 'e2', relock: true });
  });

  it('does not mark relock for cursor-mode entries', () => {
    const entered = enterFocusMode({ kind: 'free' }, 'e1', pose);
    expect(entered.kind === 'focus' && entered.relock).toBeUndefined();
  });
});

describe('pendingRelock', () => {
  it('survives a mode change to free but clears on any other mode', () => {
    useStore.getState().setPendingRelock(true);
    useStore.getState().setCameraMode({ kind: 'free' });
    expect(useStore.getState().pendingRelock).toBe(true);
    useStore.getState().setCameraMode({ kind: 'movie' });
    expect(useStore.getState().pendingRelock).toBe(false);
  });
});

describe('shouldExitFocusOnMissedClick', () => {
  const focus: CameraMode = { kind: 'focus', target: 'e1', from: { kind: 'free' } };

  it('exits when the whole gesture happened while parked in focus (a genuine click-away)', () => {
    expect(shouldExitFocusOnMissedClick(focus, focus)).toBe(true);
  });

  it('ignores the miss when the gesture itself entered focus (tap: camera is mid-flight at click time)', () => {
    expect(shouldExitFocusOnMissedClick(focus, { kind: 'free' })).toBe(false);
  });

  it('ignores the miss when the gesture switched focus between monitors', () => {
    const other: CameraMode = { kind: 'focus', target: 'e2', from: { kind: 'free' } };
    expect(shouldExitFocusOnMissedClick(focus, other)).toBe(false);
  });

  it('never exits outside focus mode', () => {
    expect(shouldExitFocusOnMissedClick({ kind: 'free' }, { kind: 'free' })).toBe(false);
  });
});

describe('patchCharacter', () => {
  it('patchCharacter optimistically patches any adjustment field', () => {
    // seed a catalog the same way the existing catalog-seeding tests do
    useStore.getState().applyServerMsg({
      type: 'catalog',
      catalog: {
        version: 1,
        generatedAt: '',
        clipAliases: {},
        characters: [{ id: 'imp', displayName: 'Imp', pack: 'Mixamo', tags: [], rig: 'embedded' }],
      },
    } as never);
    useStore.getState().patchCharacter('imp', { scale: 2, seatOffset: 0.1, chairHeight: -0.2 });
    const c = useStore.getState().catalog!.characters.find((x) => x.id === 'imp')!;
    expect(c.scale).toBe(2);
    expect(c.seatOffset).toBe(0.1);
    expect(c.chairHeight).toBe(-0.2);
  });
});

describe('lastActivity stamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetWhiteboardKeyForTest();
    resetInboxKeyForTest();
    resetStatusKeyForTest();
    resetTvStatsKeyForTest();
    useStore.setState({ office: null, stats: null, monitors: {}, monitorVersion: {}, lastActivity: {} });
  });
  afterEach(() => vi.useRealTimers());

  it('stamps the target when a monitor message appends text', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', append: 'hello\n' } as never);
    expect(useStore.getState().lastActivity['e1']).toBe(1_000_000);
  });

  it('does not stamp on clear-only monitor messages', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', clear: true } as never);
    expect(useStore.getState().lastActivity['e1']).toBeUndefined();
  });

  it('stamps the whiteboard when derived board content changes, but not on the first state', () => {
    useStore.getState().applyServerMsg({ type: 'state', state: makeOffice() });
    expect(useStore.getState().lastActivity['whiteboard']).toBeUndefined();

    vi.setSystemTime(1_005_000);
    const changed = makeOffice({
      todos: { project: 'p', items: [{ content: 'new item', status: 'pending' }], at: new Date().toISOString() },
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);

    // identical content again → no re-stamp
    vi.setSystemTime(1_009_000);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);
  });

  it('stamps the status board on a new status tail id, but not on rewrites or the first state', () => {
    const first = makeOffice({
      status: [{ id: 'status-1', at: new Date().toISOString(), text: 'raw', kind: 'boss' }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: first });
    expect(useStore.getState().lastActivity['statusboard']).toBeUndefined();

    vi.setSystemTime(1_005_000);
    const withNew = makeOffice({
      status: [
        { id: 'status-1', at: new Date().toISOString(), text: 'raw', kind: 'boss' },
        { id: 'status-2', at: new Date().toISOString(), text: 'Alice finished a job', kind: 'done' },
      ],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: withNew });
    expect(useStore.getState().lastActivity['statusboard']).toBe(1_005_000);

    // summarizer rewrite of the same tail id → no re-stamp
    vi.setSystemTime(1_009_000);
    const rewritten = makeOffice({
      status: [
        { id: 'status-1', at: new Date().toISOString(), text: 'raw', kind: 'boss' },
        { id: 'status-2', at: new Date().toISOString(), text: 'a tidy summary', kind: 'done' },
      ],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: rewritten });
    expect(useStore.getState().lastActivity['statusboard']).toBe(1_005_000);
  });

  it('tolerates a state from an older server with no status field', () => {
    const legacy = makeOffice();
    delete (legacy as Partial<OfficeState>).status;
    useStore.getState().applyServerMsg({ type: 'state', state: legacy });
    expect(useStore.getState().lastActivity['statusboard']).toBeUndefined();
  });

  it('stamps the boss when a new inbox item arrives, but not on the first state', () => {
    const first = makeOffice({
      inbox: [{ id: 'i1', project: 'p', text: 'old', at: new Date().toISOString() }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: first });
    expect(useStore.getState().lastActivity['boss']).toBeUndefined();

    vi.setSystemTime(1_005_000);
    const withNew = makeOffice({
      inbox: [
        { id: 'i1', project: 'p', text: 'old', at: new Date().toISOString() },
        { id: 'i2', project: 'p', text: 'fresh prompt', at: new Date().toISOString() },
      ],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: withNew });
    expect(useStore.getState().lastActivity['boss']).toBe(1_005_000);
  });

  it('does not re-stamp the boss when the summarizer rewrites the same inbox item', () => {
    const first = makeOffice({
      inbox: [{ id: 'i1', project: 'p', text: 'raw prompt text', at: new Date().toISOString() }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: first });
    vi.setSystemTime(1_002_000);
    const added = makeOffice({
      inbox: [
        { id: 'i1', project: 'p', text: 'raw prompt text', at: new Date().toISOString() },
        { id: 'i2', project: 'p', text: 'second', at: new Date().toISOString() },
      ],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: added });
    expect(useStore.getState().lastActivity['boss']).toBe(1_002_000);

    // summarizer swap: same tail id, new text → no re-stamp
    vi.setSystemTime(1_004_000);
    const summarized = makeOffice({
      inbox: [
        { id: 'i1', project: 'p', text: 'raw prompt text', at: new Date().toISOString() },
        { id: 'i2', project: 'p', text: 'a tidy summary', at: new Date().toISOString() },
      ],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: summarized });
    expect(useStore.getState().lastActivity['boss']).toBe(1_002_000);
  });

  it('sets stats and stamps the tv on a stats message, but not on re-broadcast of identical stats', () => {
    const stats: UsageStats = {
      trackingSince: new Date().toISOString(),
      tokensByModel: {},
      toolCalls: {},
      prompts: 1,
      sessions: 0,
      subagents: 0,
      webSearches: 0,
      webFetches: 0,
      turns: 0,
      turnMsTotal: 0,
      longestTurnMs: 0,
      peakHeadcount: 0,
      headcount: 0,
      byDay: {},
      hourCounts: {},
      tokensByDowHour: {},
      gameWins: {},
    };
    useStore.getState().applyServerMsg({ type: 'stats', stats });
    expect(useStore.getState().stats).toEqual(stats);
    expect(useStore.getState().lastActivity['tv']).toBeUndefined(); // first message never re-stamps

    vi.setSystemTime(1_005_000);
    const changed = { ...stats, prompts: 2 };
    useStore.getState().applyServerMsg({ type: 'stats', stats: changed });
    expect(useStore.getState().lastActivity['tv']).toBe(1_005_000);

    // identical broadcast again → no re-stamp
    vi.setSystemTime(1_009_000);
    useStore.getState().applyServerMsg({ type: 'stats', stats: changed });
    expect(useStore.getState().lastActivity['tv']).toBe(1_005_000);
  });
});

describe('build mode', () => {
  it('patchLayout merges optimistically into office.layout', () => {
    useStore.setState({
      office: { employees: [], inbox: [], layout: { seats: { 1: { x: 1, z: 1, rotY: 0 } } } } as unknown as OfficeState,
    });
    useStore.getState().patchLayout({ furniture: { couch: { x: 2, z: 3, rotY: 0.5 } } });
    useStore.getState().patchLayout({ seats: { 2: { x: 4, z: 4, rotY: 0 } } });
    const layout = useStore.getState().office!.layout!;
    expect(layout.seats![1]).toEqual({ x: 1, z: 1, rotY: 0 });
    expect(layout.seats![2]).toEqual({ x: 4, z: 4, rotY: 0 });
    expect(layout.furniture!.couch).toEqual({ x: 2, z: 3, rotY: 0.5 });
  });

  it('patchLayout is a no-op without an office', () => {
    useStore.setState({ office: null });
    useStore.getState().patchLayout({ furniture: { couch: { x: 2, z: 3, rotY: 0.5 } } });
    expect(useStore.getState().office).toBeNull();
  });

  it('leaving build mode drops any in-flight hold', () => {
    useStore.setState({ buildMode: true });
    useStore.getState().setBuildHold({ kind: 'furniture', key: 'couch', ghost: { x: 0, z: 0, rotY: 0 }, ghostOffset: null, valid: true });
    useStore.getState().setBuildMode(false);
    expect(useStore.getState().buildMode).toBe(false);
    expect(useStore.getState().buildHold).toBeNull();
  });

  it('entering a non-free camera mode exits build mode', () => {
    useStore.setState({ buildMode: true });
    useStore.getState().setCameraMode({ kind: 'movie' });
    expect(useStore.getState().buildMode).toBe(false);
  });
});

describe('camera mode persistence', () => {
  it('keeps free, movie and the pov index', () => {
    expect(toPersistedCameraMode({ kind: 'free' })).toEqual({ kind: 'free' });
    expect(toPersistedCameraMode({ kind: 'movie' })).toEqual({ kind: 'movie' });
    expect(toPersistedCameraMode({ kind: 'pov', index: 4 })).toEqual({ kind: 'pov', index: 4 });
  });

  it('stores focus mode as the mode it would exit to, however deeply nested', () => {
    const fromPov: CameraMode = { kind: 'focus', target: 'emp-1', from: { kind: 'pov', index: 2 } };
    expect(toPersistedCameraMode(fromPov)).toEqual({ kind: 'pov', index: 2 });
    // focus entered from focus (monitor -> monitor) still resolves to a durable mode
    const nested: CameraMode = { kind: 'focus', target: 'emp-2', from: fromPov };
    expect(toPersistedCameraMode(nested)).toEqual({ kind: 'pov', index: 2 });
  });

  it('round-trips through JSON', () => {
    for (const m of [{ kind: 'free' }, { kind: 'movie' }, { kind: 'pov', index: 7 }] as CameraMode[]) {
      expect(parseCameraMode(JSON.stringify(toPersistedCameraMode(m)))).toEqual(toPersistedCameraMode(m));
    }
  });

  it('falls back to free for missing, corrupt or unrecognized entries', () => {
    expect(parseCameraMode(null)).toEqual({ kind: 'free' });
    expect(parseCameraMode('')).toEqual({ kind: 'free' });
    expect(parseCameraMode('not json')).toEqual({ kind: 'free' });
    expect(parseCameraMode('{"kind":"focus","target":"emp-1"}')).toEqual({ kind: 'free' });
    expect(parseCameraMode('{"kind":"pov"}')).toEqual({ kind: 'free' });
    expect(parseCameraMode('{"kind":"pov","index":-1}')).toEqual({ kind: 'free' });
    expect(parseCameraMode('{"kind":"pov","index":1.5}')).toEqual({ kind: 'free' });
  });

  it('setCameraMode writes the durable mode to storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    try {
      useStore.getState().setCameraMode({ kind: 'pov', index: 3 });
      expect(parseCameraMode(store.get('thisoffice.cameraMode') ?? null)).toEqual({ kind: 'pov', index: 3 });
      // focus is stored as the mode it would exit to, not as focus
      useStore.getState().setCameraMode({ kind: 'focus', target: 'boss', from: { kind: 'movie' } });
      expect(parseCameraMode(store.get('thisoffice.cameraMode') ?? null)).toEqual({ kind: 'movie' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a throwing localStorage does not break mode changes', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    try {
      expect(() => useStore.getState().setCameraMode({ kind: 'movie' })).not.toThrow();
      expect(useStore.getState().cameraMode).toEqual({ kind: 'movie' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('layout reference stability', () => {
  beforeEach(() => {
    useStore.setState({ office: null });
    resetWhiteboardKeyForTest();
    resetInboxKeyForTest();
    resetStatusKeyForTest();
  });

  const layout = () => ({ seats: { 1: { x: 1, z: 2, rotY: 0 } }, furniture: {}, wallItems: {} });

  it('carries the previous layout reference forward when the layout is unchanged', () => {
    const apply = useStore.getState().applyServerMsg;
    apply({ type: 'state', state: makeOffice({ layout: layout() } as never) });
    const first = useStore.getState().office!.layout;

    // a later broadcast (status push, hire, monitor title) re-parses everything
    apply({ type: 'state', state: makeOffice({ layout: layout(), bossStatus: 'working' } as never) });
    const second = useStore.getState().office!.layout;

    expect(second).toBe(first); // identity preserved → Desks don't re-render
    expect(useStore.getState().office!.bossStatus).toBe('working'); // rest still updates
  });

  it('takes the new layout when it actually changed', () => {
    const apply = useStore.getState().applyServerMsg;
    apply({ type: 'state', state: makeOffice({ layout: layout() } as never) });
    const first = useStore.getState().office!.layout;

    const moved = layout();
    moved.seats[1].x = 9;
    apply({ type: 'state', state: makeOffice({ layout: moved } as never) });
    const second = useStore.getState().office!.layout;

    expect(second).not.toBe(first);
    expect((second as never as ReturnType<typeof layout>).seats[1].x).toBe(9);
  });

  it('handles a missing layout on either side', () => {
    const apply = useStore.getState().applyServerMsg;
    apply({ type: 'state', state: makeOffice() });
    expect(useStore.getState().office!.layout).toBeUndefined();
    apply({ type: 'state', state: makeOffice({ layout: layout() } as never) });
    expect(useStore.getState().office!.layout).toBeDefined();
  });
});

const quizState = (over: Partial<QuizState> = {}): QuizState => ({
  enabled: true,
  roundId: 'r1',
  askedCount: 1,
  answers: [],
  question: { id: 'q1', text: 'Is it alive?', guess: false, asker: 'e1', askerName: 'Dana', at: '2026-07-26T00:00:00.000Z' },
  awaitingPhoto: false,
  winner: null,
  ...over,
});

describe('quiz messages', () => {
  beforeEach(() => {
    useStore.setState({ quiz: null, pendingCapture: null });
  });

  it('stores quiz state', () => {
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState() });
    expect(useStore.getState().quiz!.question!.text).toBe('Is it alive?');
  });

  it('records a capture request only when one is addressed to this client', () => {
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true }) });
    expect(useStore.getState().pendingCapture).toBeNull();

    const winner = { name: 'Dana', variant: 'Mage', at: '2026-07-26T00:00:00.000Z' };
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }), capture: winner });
    expect(useStore.getState().pendingCapture).toEqual(winner);

    useStore.getState().clearPendingCapture();
    expect(useStore.getState().pendingCapture).toBeNull();
  });

  it('drops a pending capture when the server stops waiting for a photo', () => {
    const winner = { name: 'Dana', variant: 'Mage', at: '2026-07-26T00:00:00.000Z' };
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }), capture: winner });
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: false }) });
    expect(useStore.getState().pendingCapture).toBeNull();
  });

  it('keeps a pending capture across a later broadcast that carries no capture field, while still awaiting a photo', () => {
    const winner = { name: 'Dana', variant: 'Mage', at: '2026-07-26T00:00:00.000Z' };
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }), capture: winner });
    expect(useStore.getState().pendingCapture).toEqual(winner);

    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }) });
    expect(useStore.getState().pendingCapture).toEqual(winner);
  });
});
