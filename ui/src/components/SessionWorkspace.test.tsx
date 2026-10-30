// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/types';
import { SessionWorkspace } from './SessionWorkspace';

vi.mock('@/hooks/useSessionPreview', () => ({ useSessionPreview: () => ({ state: { kind: 'loading' }, refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('reports separator bounds consistently at Home and End for fractional pane limits', () => {
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: DOMRect.fromRect({ width: 655 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', fileName: 'demo.html' } };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal content</div></SessionWorkspace>);
  const separator = screen.getByRole('separator', { name: 'Resize terminal and preview' });
  const values = () => ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map(name => Number(separator.getAttribute(name)));
  fireEvent.keyDown(separator, { key: 'Home' });
  let [min, now, max] = values();
  expect(min).toBe(37.1); expect(now).toBe(min); expect(now).toBeLessThanOrEqual(max);
  fireEvent.keyDown(separator, { key: 'End' });
  [min, now, max] = values();
  expect(max).toBe(62.9); expect(now).toBe(max); expect(now).toBeGreaterThanOrEqual(min);
});
