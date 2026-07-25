import { describe, expect, it } from 'vitest';
import { pickMonitorTarget, type PickHit } from './monitorPicking.ts';

function hit(userData: Record<string, unknown>, visible = true, type = 'Mesh'): PickHit {
  return { object: { userData, visible, type } };
}

describe('pickMonitorTarget', () => {
  it('returns the target of the first monitor mesh hit', () => {
    expect(pickMonitorTarget([hit({ monitorTarget: 'e1' })])).toBe('e1');
  });

  it('returns null when solid geometry is in front of the monitor', () => {
    expect(pickMonitorTarget([hit({}), hit({ monitorTarget: 'e1' })])).toBeNull();
  });

  it('sees through invisible collider meshes', () => {
    expect(pickMonitorTarget([hit({}, false), hit({ monitorTarget: 'e1' })])).toBe('e1');
  });

  it('sees through nametag sprites', () => {
    expect(pickMonitorTarget([hit({}, true, 'Sprite'), hit({ monitorTarget: 'e1' })])).toBe('e1');
  });

  it('returns null when nothing is hit', () => {
    expect(pickMonitorTarget([])).toBeNull();
  });
});
