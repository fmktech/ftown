// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudConnectionNotice } from './CloudConnectionNotice';

afterEach(cleanup);

it('leaves terminals interactive during an outage and hides the notice on recovery', () => {
  const input = vi.fn();
  const props = {
    connectionStatus: 'error' as const,
    connectionError: 'transport closed',
    centrifugoUrl: 'wss://example.com/connection/websocket',
    token: '',
    onRetry: vi.fn(),
  };
  const view = render(createElement('div', null,
    createElement('button', { onClick: input }, 'Terminal'),
    createElement(CloudConnectionNotice, props),
  ));
  expect(screen.queryByText('Connection Failed')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('reconnecting automatically');
  fireEvent.click(screen.getByText('Terminal'));
  expect(input).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Connection details'));
  expect(screen.getByText('Connection Failed')).toBeTruthy();
  fireEvent.click(screen.getByText('Back to terminals'));
  expect(screen.queryByText('Connection Failed')).toBeNull();
  fireEvent.click(screen.getByText('Connection details'));
  view.rerender(createElement(CloudConnectionNotice, { ...props, connectionStatus: 'connected' }));
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(createElement(CloudConnectionNotice, props));
  expect(screen.queryByText('Connection Failed')).toBeNull();
  expect(props.onRetry).not.toHaveBeenCalled();
});
