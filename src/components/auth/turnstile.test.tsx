import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@marsidev/react-turnstile', () => ({
  Turnstile: ({ onSuccess }: { onSuccess: (t: string) => void }) => {
    onSuccess('test-token');
    return <div data-testid="turnstile-widget" />;
  },
}));

import { TurnstileWidget } from './turnstile';

describe('TurnstileWidget', () => {
  it('renders the widget and reports the token via onToken', () => {
    const onToken = vi.fn();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    render(<TurnstileWidget onToken={onToken} />);
    expect(screen.getByTestId('turnstile-widget')).toBeInTheDocument();
    expect(onToken).toHaveBeenCalledWith('test-token');
  });
});
