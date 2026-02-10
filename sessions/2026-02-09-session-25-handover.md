# Session 25 Handover - Landing Page GSAP Redesign

## Date
2026-02-09

## Summary
Redesigned the AlgoCrypto landing page from basic Framer Motion animations to a premium, startup-quality page with GSAP-driven scroll animations, Lenis smooth scrolling, interactive 3D wireframe globe, and multiple new sections.

## Commit
`dc1781b feat(marketing): redesign landing page with AlgoCrypto branding and animations`

## What Changed

### New Dependencies
- `gsap` + `@gsap/react` -- ScrollTrigger, TextPlugin, useGSAP hook
- `lenis` -- smooth momentum scrolling (marketing layout only)

### New Files
- `src/lib/gsap.ts` -- centralized GSAP plugin registration
- `src/components/marketing/SmoothScroll.tsx` -- Lenis provider wrapper
- `src/components/marketing/LandingButton.tsx` -- `<a>` element with fill-sweep hover (outline) and solid accent variants
- `src/components/marketing/HeroBackground.tsx` -- parallax orbs + self-drawing SVG chart line
- `src/components/marketing/GlobeScene.tsx` -- Three.js wireframe globe (fibonacci sphere, mouse-reactive tilt)
- `src/components/marketing/HowItWorksSection.tsx` -- Connect/Configure/Automate 3-step flow
- `src/components/marketing/StatsSection.tsx` -- GSAP animated number counters
- `src/__mocks__/gsap.ts`, `src/__mocks__/@gsap/react.ts`, `src/__mocks__/lenis.ts` -- test mocks

### Modified Files
- `HeroSection.tsx` -- GSAP TextPlugin typewriter, staggered entry
- `AnimatedChartSection.tsx` -- GSAP strokeDashoffset draw, data points, glow
- `FeaturesSection.tsx` -- mouse spotlight cards, GSAP ScrollTrigger stagger
- `CTASection.tsx` -- rotating gradient border, GSAP fade-in
- `CoinSceneWrapper.tsx` -- references GlobeScene, "Global Algorithmic Network"
- `Footer.tsx` -- social links, tagline
- `page.tsx` -- new section order with HowItWorks and Stats
- All marketing test files updated

### Key Design Decisions
- LandingButton renders as `<a>` with `href` prop (not `<button>` inside `<Link>`) -- solves navigation issues
- GSAP for marketing, Framer Motion stays for dashboard (no conflict)
- All animations respect `prefers-reduced-motion`
- SmoothScroll only wraps marketing layout

## Test Results
- Unit tests: 1089 passing (123 files)
- E2E tests: 76/77 pass (1 pre-existing flaky alerts test)
- Landing E2E: all 27 pass (desktop + mobile)
- Lint: 0 errors
- TypeScript: clean
- Build: clean

## Known Issues
- Untracked backtest files from a git stash exist in the working tree (not committed, not part of this work)
- 1 flaky E2E test in alerts spec (pre-existing, unrelated)

## Next Steps
- Phase 8 planning (if any)
- Consider cleaning up untracked backtest files (either commit to a branch or remove)
