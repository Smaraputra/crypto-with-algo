# Session 23 Handover -- AlgoCrypto Landing Page Redesign

## Date
2026-02-09

## Summary
Redesigned the landing page with AlgoCrypto branding, Framer Motion scroll-triggered animations, a Three.js 3D rotating coin, and an animated SVG chart section. Removed StatsSection and replaced it with richer visual content.

## Changes Made

### New Dependencies
- `framer-motion` -- scroll-triggered entrance animations (LazyMotion + domAnimation for minimal bundle)
- `three` + `@react-three/fiber` -- 3D rendering (dynamically imported, SSR disabled)
- `@react-three/drei` -- Three.js helpers (dev dependency `@types/three` also added)

### Rebranding
- Renamed "Crypto Portfolio Tracker" / "Crypto Tracker" to "AlgoCrypto" across all layout files, marketing components, and dashboard components
- Swapped `Star` icon to `Zap` from lucide-react in LandingNav, Footer, auth layout, Sidebar

### New Components
- `CoinScene.tsx` -- Three.js rotating gold coin with metallic materials, torus rim, hexagonal emblem (no external resource fetches to avoid CSP issues)
- `CoinSceneWrapper.tsx` -- `'use client'` wrapper using `next/dynamic` with `ssr: false`
- `AnimatedChartSection.tsx` -- SVG path with Framer Motion `pathLength` animation on scroll, green gradient fill

### Animated Sections
- `HeroSection.tsx` -- converted to `'use client'`, uses `motion.div` / `motion.h1` / `motion.p` with staggered entrance animations via `containerVariants` / `itemVariants`
- `FeaturesSection.tsx` -- converted to `'use client'`, scroll-triggered stagger animations using `useInView` and `variants`

### Removed
- `StatsSection.tsx` and its test (replaced by CoinScene + AnimatedChart sections)

### Other
- Added `worker-src 'self' blob:` to CSP in `next.config.ts` for Three.js web workers
- `PortfolioValueChart.tsx` -- replaced oklch colors with hex equivalents for lightweight-charts compatibility

### Test Infrastructure
- Created `src/__mocks__/framer-motion.tsx` -- Proxy-based mock that strips motion props and renders plain HTML
- Created `src/__mocks__/@react-three/fiber.tsx` -- Mock Canvas renders div with `data-testid`
- Created `src/__mocks__/@react-three/drei.tsx` -- Stub exports

## Test Results
- Unit: 837 tests passing (93 files) -- up from 803
- E2E: 62 tests passing (all pre-existing flaky failures pass on retry)
- Lint: 0 errors
- TypeScript: clean
- Build: clean

## Key Gotchas Encountered
- Three.js `Environment` (drei) and `Text` (drei) both fetch external resources (HDR, fonts) blocked by CSP -- replaced with pure geometry and extra lights
- `vi.mock` with `require()` violates `@typescript-eslint/no-require-imports` -- use `async () => await import(...)` pattern
- Framer Motion's `Variants` type needs `ease: 'easeOut' as const` (literal type, not generic string)
- `next/dynamic` with `ssr: false` is NOT allowed in Server Components -- must use `'use client'` wrapper

## Landing Page Section Order
1. LandingNav
2. HeroSection (animated entrance)
3. CoinSceneWrapper (3D rotating coin)
4. AnimatedChartSection (scroll-triggered SVG path)
5. FeaturesSection (scroll-triggered card stagger)
6. CTASection
7. Footer

## Next Steps
- Consider adding OrbitControls to the 3D coin for user interaction
- Consider adding more particle effects or background animations
- Performance audit of Three.js bundle size in production
