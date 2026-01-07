# Ascent UI Design System

## The Anti-Slop Manifesto

**What we're avoiding:**

- Purple/blue gradients (the "AI" palette)
- Glassmorphism with gradient borders
- Excessive blur effects
- Particle animations, floating dots
- Neon glows on dark backgrounds
- Inter, SF Pro, or any system font as display
- Rounded everything (pills, circles, blobs)
- Gratuitous motion for motion's sake
- "Tech startup" aesthetic (Stripe clones)
- Achievement badges, confetti, gamification theater

**What we're building:**
A tool that looks like it was designed by someone who understands attention disorders—*calm*, *clear*, *low visual noise*, and *high information density* when needed.

---

## Design Philosophy: Pharmacist Clarity

Think of how well-designed medical software looks vs. consumer apps. Medical interfaces prioritize:

- Immediate comprehension under cognitive load
- Zero ambiguity about state
- Functional density without clutter
- Confidence through precision, not decoration

Ascent should feel like a *precision instrument*, not a toy. The aesthetic is: **clinical warmth**—professional enough to trust, warm enough to not feel cold.

---

## Structure

```
design-system/
├── README.md                 # You are here
├── foundations/
│   ├── colors.md             # Color system + palette
│   ├── typography.md         # Font stack + type scale
│   ├── spacing.md            # Spacing system
│   └── animation.md          # Animation guidelines
├── components/
│   ├── dopamine-pool.md      # Hero pool visualization
│   ├── habit-card.md         # Habit list items
│   ├── intention-card.md     # Today's primary CTA
│   ├── navigation.md         # Bottom tab bar
│   ├── coach-interface.md    # AI coach modal
│   └── settings.md           # Settings rows
├── screens/
│   ├── home.md               # Today view
│   ├── habits.md             # Full tracker
│   ├── goal.md               # Goal/curriculum
│   └── onboarding/
│       └── README.md         # Complete onboarding flow
├── patterns/
│   ├── dark-mode.md          # Dark mode palette + rules
│   ├── accessibility.md      # A11y guidelines
│   └── widgets.md            # iOS widget designs
└── implementation/
    └── tech-notes.md         # Stack, performance, fonts
```

---

## Summary: The Ascent Look

| Attribute   | Ascent                          | Typical Habit App                |
|-------------|--------------------------------|----------------------------------|
| Color       | Warm neutrals, semantic accents | Gradients, purple/teal           |
| Typography  | Serif headlines, geometric body | Sans-serif everything            |
| Animation   | Spring physics, minimal         | Bouncy, celebratory              |
| Density     | High information, low noise     | Low information, high decoration |
| Personality | Clinical warmth                 | Gamified enthusiasm              |
| Tone        | Observational, matter-of-fact   | Motivational, cheerleading       |

**The goal:** An app that feels like it was designed by someone who understands that attention is precious and shouldn't be wasted on decoration—including their own app's decoration.
