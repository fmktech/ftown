// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/types';
import { PreviewConversation } from './PreviewConversation';
afterEach(cleanup);
it('uses accessible controls, preserves multiline keyboard input and sends only plain Enter', () => {
 const session = { status: 'running' } as Session; const send = vi.fn(); const open = vi.fn();
 const conversation = { draft: 'hello', draftValid: true, turns: [], error: null, sending: false, pendingMode: null, canSend: true, setDraft: vi.fn(), send };
 const view = render(<PreviewConversation open={false} onOpen={open} onClose={() => {}} session={session} conversation={conversation} />);
 fireEvent.click(screen.getByRole('button', { name: 'Open conversation' })); expect(open).toHaveBeenCalledOnce();
 view.rerender(<PreviewConversation open onOpen={open} onClose={() => {}} session={session} conversation={conversation} />);
 const input = screen.getByRole('textbox', { name: 'Message the agent' });
 fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); fireEvent.keyDown(input, { key: 'Enter', repeat: true }); expect(send).not.toHaveBeenCalled();
 fireEvent.keyDown(input, { key: 'Enter' }); expect(send).toHaveBeenCalledOnce();
 expect(screen.getByRole('status').textContent).toBe('Running');
});
