import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@marsidev/react-turnstile', () => ({
  Turnstile: ({ onSuccess }: { onSuccess: (t: string) => void }) => {
    onSuccess('cf-token');
    return <div data-testid="turnstile-widget" />;
  },
}));

import { TurnstileWidget } from './turnstile';

afterEach(() => vi.unstubAllEnvs());

describe('TurnstileWidget', () => {
  it('renders the real Cloudflare widget and reports its token for a production site key', () => {
    const onToken = vi.fn();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '0x4AAAAAArealproductionkey');
    render(<TurnstileWidget onToken={onToken} />);
    expect(screen.getByTestId('turnstile-widget')).toBeInTheDocument();
    expect(onToken).toHaveBeenCalledWith('cf-token');
  });

  it('renders a stub and auto-provides a token for a Cloudflare test site key', () => {
    const onToken = vi.fn();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    render(<TurnstileWidget onToken={onToken} />);
    expect(screen.getByTestId('turnstile-test-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('turnstile-widget')).not.toBeInTheDocument();
    expect(onToken).toHaveBeenCalledWith('test-turnstile-token');
  });

  it('renders nothing when no site key is configured', () => {
    const onToken = vi.fn();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    const { container } = render(<TurnstileWidget onToken={onToken} />);
    expect(container).toBeEmptyDOMElement();
    expect(onToken).not.toHaveBeenCalled();
  });
});
