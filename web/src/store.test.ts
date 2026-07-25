import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeState } from '../../shared/types.ts';
import {
  enterFocusMode,
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
    // seed a catalog the same way the existing setCharacterScale test does
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
});
