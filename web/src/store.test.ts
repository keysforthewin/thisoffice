import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeState } from '../../shared/types.ts';
import {
  enterFocusMode,
  resetInboxKeyForTest,
  resetWhiteboardKeyForTest,
  shouldExitFocusOnMissedClick,
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
    useStore.setState({ office: null, monitors: {}, monitorVersion: {}, lastActivity: {} });
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
      inbox: [{ id: 'i1', project: 'p', text: 'new prompt', at: new Date().toISOString() }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);

    // identical content again → no re-stamp
    vi.setSystemTime(1_009_000);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);
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
