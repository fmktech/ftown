// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionHeaderActions } from './SessionHeaderActions';

afterEach(cleanup);

const handlers = () => ({ onPreview: vi.fn(), onStop: vi.fn(), onRelaunch: vi.fn() });
const base = { running: false, relaunchLabel: null };

it('offers a reopen control only while a preview exists and is closed', () => {
  const closed = handlers();
  const { unmount } = render(<SessionHeaderActions {...base} hasPreview previewOpen={false} {...closed} />);
  const reopen = screen.getByRole('button', { name: 'Open preview' });
  fireEvent.click(reopen);
  expect(closed.onPreview).toHaveBeenCalledTimes(1);
  unmount();

  render(<SessionHeaderActions {...base} hasPreview previewOpen {...handlers()} />);
  expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull();
  cleanup();

  render(<SessionHeaderActions {...base} hasPreview={false} previewOpen={false} {...handlers()} />);
  expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull();
});
