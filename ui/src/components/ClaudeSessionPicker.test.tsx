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

it('shows the code for the observed permission denial below the load error', async () => {
  const sendCommand = vi.fn().mockResolvedValue({ success: false, error: 'permission_denied', data: { code: 'permission_denied', outcomeUnknown: false } });
  render(<ClaudeSessionPicker bridgeId="a24d2e44-d63f-4fa4-ad53-4b9a594e23cf" workingDir="/Users/fkesheh/projects/legbi-v3" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  const message = await screen.findByText("Couldn't load Claude sessions.");
  const code = screen.getByText('Code: permission_denied');
  expect(message.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_native_sessions', payload: { bridgeId: 'a24d2e44-d63f-4fa4-ad53-4b9a594e23cf', workingDir: '/Users/fkesheh/projects/legbi-v3', harness: 'claude' } }));
});

it('shows a safe typed error code and hides unsafe codes', async () => {
  const sendCommand = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private detail'), { code: 'permission_denied' }))
    .mockRejectedValueOnce(Object.assign(new Error('private detail'), { code: '<unsafe>' }));
  const { rerender } = render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  expect(await screen.findByText('Code: permission_denied')).toBeTruthy();
  rerender(<ClaudeSessionPicker bridgeId="bridge" workingDir="/other" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  await waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Code: permission_denied')).toBeNull());
  expect(screen.queryByText(/unsafe|private detail/)).toBeNull();
});

it('clears the error code on retry and displays successful results', async () => {
  const sendCommand = vi.fn().mockResolvedValueOnce({ success: false, data: { code: 'permission_denied' } })
    .mockResolvedValueOnce({ success: true, data: { sessions: [{ sessionId: 'claude-123', timestamp: '2026-01-01T00:00:00Z', summary: 'Recovered session' }] } });
  render(<ClaudeSessionPicker bridgeId="bridge" workingDir="/work" account="default" sendCommand={sendCommand} onSelect={vi.fn()} />);
  expect(await screen.findByText('Code: permission_denied')).toBeTruthy();
  screen.getByRole('button', { name: 'Retry' }).click();
  expect(await screen.findByText('Recovered session')).toBeTruthy();
  expect(screen.queryByText('Code: permission_denied')).toBeNull();
});
