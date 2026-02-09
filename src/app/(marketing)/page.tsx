import { LandingNav } from '@/components/marketing/LandingNav';
import { HeroSection } from '@/components/marketing/HeroSection';
import { CoinSceneWrapper } from '@/components/marketing/CoinSceneWrapper';
import { AnimatedChartSection } from '@/components/marketing/AnimatedChartSection';
import { FeaturesSection } from '@/components/marketing/FeaturesSection';
import { HowItWorksSection } from '@/components/marketing/HowItWorksSection';
import { StatsSection } from '@/components/marketing/StatsSection';
import { CTASection } from '@/components/marketing/CTASection';
import { Footer } from '@/components/marketing/Footer';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main id="main-content">
        <HeroSection />
        <CoinSceneWrapper />
        <AnimatedChartSection />
        <FeaturesSection />
        <HowItWorksSection />
        <StatsSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
