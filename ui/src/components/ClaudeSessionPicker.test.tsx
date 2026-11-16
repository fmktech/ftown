// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeSessionPicker } from './ClaudeSessionPicker';

afterEach(cleanup);
it('requests Claude sessions through the bridge RPC and renders selectable results', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ sessionId: 'claude-123', timestamp: '2026-01-01T00:00:00Z', summary: 'Resume this' }] } });
  const onSelect = vi.fn();
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" sendCommand={sendCommand} onSelect={onSelect} />);
  await waitFor(() => expect(screen.getByText('Resume this')).toBeTruthy());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_native_sessions', payload: { bridgeId: 'bridge', workingDir: '/work', harness: 'claude' } }));
  screen.getByRole('option').click(); expect(onSelect).toHaveBeenCalledWith('claude-123', 'Resume this');
});
