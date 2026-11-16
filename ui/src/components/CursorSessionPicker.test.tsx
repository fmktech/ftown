// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CursorSessionPicker } from './CursorSessionPicker';

afterEach(cleanup);
it('requests Cursor sessions through the bridge RPC and renders selectable results', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ sessionId: 'cursor-123', timestamp: '1700000000000', summary: 'Cursor task' }] } });
  const onSelect = vi.fn();
  render(<CursorSessionPicker bridgeId="bridge" workingDir="/work" sendCommand={sendCommand} onSelect={onSelect} />);
  await waitFor(() => expect(screen.getByText('Cursor task')).toBeTruthy());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_native_sessions', payload: { bridgeId: 'bridge', workingDir: '/work', harness: 'cursor' } }));
  screen.getByRole('option').click(); expect(onSelect).toHaveBeenCalledWith('cursor-123', 'Cursor task');
});
