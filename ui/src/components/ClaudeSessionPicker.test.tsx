// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeSessionPicker } from './ClaudeSessionPicker';

afterEach(cleanup);
it('requests Claude sessions through the bridge RPC and renders selectable results', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ sessionId: 'claude-123', timestamp: '2026-01-01T00:00:00Z', summary: 'Resume this' }] } });
  const onSelect = vi.fn();
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="default" sendCommand={sendCommand} onSelect={onSelect} />);
  await waitFor(() => expect(screen.getByText('Resume this')).toBeTruthy());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_native_sessions', payload: { bridgeId: 'bridge', workingDir: '/work', harness: 'claude' } }));
  screen.getByRole('option').click(); expect(onSelect).toHaveBeenCalledWith('claude-123', 'Resume this');
});

it('requests sessions for the selected Claude account', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { sessions: [] } });
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="vitalsigns" sendCommand={sendCommand} onSelect={vi.fn()} />);
  await waitFor(() => expect(sendCommand).toHaveBeenCalled());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_native_sessions', payload: { bridgeId: 'bridge', workingDir: '/work', harness: 'claude', account: 'vitalsigns' } }));
});

it('explains that the bridge needs an upgrade when the list RPC is unsupported', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: false, error: 'Unknown command type: list_native_sessions' });
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  expect(await screen.findByText("Upgrade this computer's ftown bridge to load Claude sessions.")).toBeTruthy();
  expect(screen.queryByText("Couldn't load Claude sessions.")).toBeNull();
});

it('explains that the bridge needs an upgrade when it rejects account-scoped listing', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: false, error: 'Invalid native session list request' });
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="vitalsigns" sendCommand={sendCommand} onSelect={vi.fn()} />);
  expect(await screen.findByText("Upgrade this computer's ftown bridge to load Claude sessions.")).toBeTruthy();
});

it('shows the normal load error for a native projects-directory failure', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: false, error: 'ENOTDIR: not a directory' });
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  expect(await screen.findByText("Couldn't load Claude sessions.")).toBeTruthy();
});
