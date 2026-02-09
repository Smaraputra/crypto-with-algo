import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/marketing/LandingNav', () => ({
  LandingNav: () => <nav data-testid="landing-nav" />,
}));
vi.mock('@/components/marketing/HeroSection', () => ({
  HeroSection: () => <section data-testid="hero-section" />,
}));
vi.mock('@/components/marketing/CoinSceneWrapper', () => ({
  CoinSceneWrapper: () => <section data-testid="coin-scene-wrapper" />,
}));
vi.mock('@/components/marketing/AnimatedChartSection', () => ({
  AnimatedChartSection: () => <section data-testid="animated-chart-section" />,
}));
vi.mock('@/components/marketing/FeaturesSection', () => ({
  FeaturesSection: () => <section data-testid="features-section" />,
}));
vi.mock('@/components/marketing/HowItWorksSection', () => ({
  HowItWorksSection: () => <section data-testid="how-it-works-section" />,
}));
vi.mock('@/components/marketing/StatsSection', () => ({
  StatsSection: () => <section data-testid="stats-section" />,
}));
vi.mock('@/components/marketing/CTASection', () => ({
  CTASection: () => <section data-testid="cta-section" />,
}));
vi.mock('@/components/marketing/Footer', () => ({
  Footer: () => <footer data-testid="footer" />,
}));

import LandingPage from './page';

describe('LandingPage', () => {
  it('renders all sections', () => {
    render(<LandingPage />);

    expect(screen.getByTestId('landing-nav')).toBeInTheDocument();
    expect(screen.getByTestId('hero-section')).toBeInTheDocument();
    expect(screen.getByTestId('coin-scene-wrapper')).toBeInTheDocument();
    expect(screen.getByTestId('animated-chart-section')).toBeInTheDocument();
    expect(screen.getByTestId('features-section')).toBeInTheDocument();
    expect(screen.getByTestId('how-it-works-section')).toBeInTheDocument();
    expect(screen.getByTestId('stats-section')).toBeInTheDocument();
    expect(screen.getByTestId('cta-section')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  it('main element has id="main-content" for skip link', () => {
    render(<LandingPage />);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });
});
