import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the image with src /logo.png and text CryptoWithAlgo', () => {
    const { container } = render(<BrandMark />);

    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(decodeURIComponent(img?.getAttribute('src') ?? '')).toContain('/logo.png');
    expect(img).toHaveAttribute('alt', '');
    expect(screen.getByText('CryptoWithAlgo')).toBeInTheDocument();
  });

  it('renders a link with aria-label="CryptoWithAlgo home" and min-h-[44px] when href is provided', () => {
    render(<BrandMark href="/dashboard" />);

    const link = screen.getByRole('link', { name: 'CryptoWithAlgo home' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/dashboard');
    expect(link).toHaveClass('min-h-[44px]');
  });

  it('renders without link when href is omitted', () => {
    render(<BrandMark />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('CryptoWithAlgo')).toBeInTheDocument();
  });

  it('sets appropriate dimensions according to size', () => {
    const { container: containerSm } = render(<BrandMark size="sm" />);
    const imgSm = containerSm.querySelector('img');
    expect(imgSm).toHaveAttribute('width', '20');
    expect(imgSm).toHaveAttribute('height', '20');

    const { container: containerMd } = render(<BrandMark size="md" />);
    const imgMd = containerMd.querySelector('img');
    expect(imgMd).toHaveAttribute('width', '24');
    expect(imgMd).toHaveAttribute('height', '24');

    const { container: containerLg } = render(<BrandMark size="lg" />);
    const imgLg = containerLg.querySelector('img');
    expect(imgLg).toHaveAttribute('width', '28');
    expect(imgLg).toHaveAttribute('height', '28');
  });
});
