# Onboarding Flow

**Philosophy:** Question → Action → Sleep → Reflection → Action → Sleep…

The user *experiences* the mechanism before they understand it.

---

## Flow Overview

| Screen | Day | Purpose |
|--------|-----|---------|
| 1. Drain Selection | 1 | Identify dopamine drains |
| 2. Micro-Friction | 1 | First intervention |
| 3-6. Daily Check-ins | 2-5 | Reflection + next drain |
| 7. Pivot Observation | 6 | First education moment |
| 8. Habit Selection | 6 | Choose what to build |
| 9. 2-Minute Version | 6 | Define success threshold |
| 10. Tracker Unlocked | 6 | Welcome to the app |

---

## Screen 1: Drain Selection

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  What keeps stealing                            │
│  your time?                                     │
│                                                 │
│                                                 │
│  ┌──────────────┐  ┌──────────────┐             │
│  │              │  │              │             │
│  │   TikTok     │  │  Instagram   │             │
│  │              │  │              │             │
│  └──────────────┘  └──────────────┘             │
│                                                 │
│  ┌──────────────┐  ┌──────────────┐             │
│  │              │  │              │             │
│  │   YouTube    │  │   Games      │             │
│  │              │  │              │             │
│  └──────────────┘  └──────────────┘             │
│                                                 │
│  ┌──────────────┐  ┌──────────────┐             │
│  │              │  │              │             │
│  │   Twitter    │  │   Other      │             │
│  │              │  │              │             │
│  └──────────────┘  └──────────────┘             │
│                                                 │
│                                                 │
│              Select 1-3 to continue             │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Visual Treatment

- **Question:** Instrument Serif, `--text-3xl`, left-aligned
- **Tiles:** Large (minimum 100px), square-ish, subtle border
- **Selected state:** Border becomes `--accent-action`, checkmark in corner
- **No app icons** (legal simplicity, cleaner look)
- **Footer hint:** `--text-tertiary`, appears after first selection

### Animation

- Tiles fade in with 100ms stagger
- Selection: Border color interpolates (150ms), scale 0.97 (spring)

```jsx
const tileVariants = {
  initial: { opacity: 0, y: 10 },
  animate: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.2 }
  }),
  selected: {
    borderColor: 'var(--accent-action)',
    scale: 0.97
  }
};
```

---

## Screen 2: Micro-Friction

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  Before you open Instagram,                     │
│  take a breath and count to 5.                  │
│                                                 │
│  That pause is everything.                      │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│          ┌─────────────────────────┐            │
│          │     I'll try this       │            │
│          └─────────────────────────┘            │
│                                                 │
│             Not right now                       │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Visual Treatment

- **Personalized copy** based on drain selection
- **Massive whitespace**—let the instruction breathe
- **Primary CTA:** Full-width button
- **Secondary option:** Text link, small, non-judgmental

**No "why it works" explanation here.** They haven't earned the context yet.

---

## Screens 3-6: Daily Check-ins (Days 2-5)

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  Day 3                                          │
│                                                 │
│  Yesterday, you tried pausing                   │
│  before opening TikTok.                         │
│                                                 │
│  How'd it go?                                   │
│                                                 │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  Did the pause at least once             │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  Tried but forgot                        │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  Didn't try                              │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Key Principles

- **All responses are valid.** No green checkmarks, no red X marks
- Just neutral selection styling
- After selection → next friction suggestion for next drain in rotation

---

## Screen 7: Pivot Observation (Day 6)

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  Something interesting                          │
│  happens when you create                        │
│  friction with empty calories.                  │
│                                                 │
│  You start noticing a gap—                      │
│  an uncomfortable restlessness                  │
│  where scrolling used to be.                    │
│                                                 │
│  That gap is what we're after.                  │
│                                                 │
│  The next question is:                          │
│  what do you want to fill it with?              │
│                                                 │
│                                                 │
│          ┌─────────────────────────┐            │
│          │       Continue          │            │
│          └─────────────────────────┘            │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Key Principle

This is the **first "education" moment.** But it's explaining something they've already felt—not trying to convince them.

---

## Screen 8: Habit Selection

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  What do you actually want                      │
│  to spend time on?                              │
│                                                 │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │                                         │    │
│  │  Type a habit you've been meaning to    │    │
│  │  start...                               │    │
│  │                                         │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  EXAMPLES                                       │
│  ┌─────────┐ ┌─────────┐ ┌───────────────┐     │
│  │ Reading │ │ Running │ │ Meditating    │     │
│  └─────────┘ └─────────┘ └───────────────┘     │
│  ┌─────────┐ ┌─────────────┐ ┌───────────┐     │
│  │ Writing │ │ Learning... │ │ Stretching│     │
│  └─────────┘ └─────────────┘ └───────────┘     │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Visual Treatment

- **Text input:** Large, minimal styling (bottom border only, no box)
- **Example pills:** Tappable, fill the input when tapped
- **No categories, no icons, no scrolling lists**

---

## Screen 9: 2-Minute Version

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│  Every habit has a                              │
│  2-minute version.                              │
│                                                 │
│  "Reading" becomes:                             │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  YOUR HABIT                             │    │
│  │  Reading                                │    │
│  │                                         │    │
│  │  2-MINUTE VERSION                       │    │
│  │  Open the book to where I left off.     │    │
│  │  Read one page.                         │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  This is what counts as "done."                 │
│  Everything else is bonus.                      │
│                                                 │
│          ┌─────────────────────────┐            │
│          │     Start tracking      │            │
│          └─────────────────────────┘            │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Key Details

- **2-minute version is auto-generated by AI** based on input
- User can edit if they don't like it
- Card shows both versions side by side

---

## Screen 10: Tracker Unlocked

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                    ✓                            │
│                                                 │
│              You're in.                         │
│                                                 │
│  The goal isn't perfection.                     │
│  It's showing up.                               │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│                                                 │
│          ┌─────────────────────────┐            │
│          │      Let's go           │            │
│          └─────────────────────────┘            │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Key Principle

**Minimal celebration.** A single checkmark, not confetti. The message reinforces the core philosophy without lecturing.

---

## Common Styles

```css
/* Onboarding screen container */
.onboarding-screen {
  flex: 1;
  background: var(--bg-primary);
  padding: var(--space-7) var(--space-5);
  justify-content: space-between;
}

/* Main question text */
.onboarding-question {
  font-family: 'Instrument Serif';
  font-size: var(--text-3xl);
  color: var(--text-primary);
  line-height: 1.2;
}

/* Body text */
.onboarding-body {
  font-family: 'DM Sans';
  font-size: var(--text-lg);
  color: var(--text-primary);
  line-height: 1.5;
}

/* Selection tile */
.selection-tile {
  min-width: 100px;
  min-height: 100px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'DM Sans';
  font-size: var(--text-base);
}

.selection-tile.selected {
  border-color: var(--accent-action);
  border-width: 2px;
}

/* Option button (full-width selection) */
.option-button {
  width: 100%;
  padding: var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  text-align: left;
  font-family: 'DM Sans';
  font-size: var(--text-base);
}

/* Primary CTA */
.onboarding-cta {
  width: 100%;
  padding: var(--space-4);
  background: var(--accent-action);
  color: white;
  border: none;
  border-radius: 8px;
  font-family: 'DM Sans';
  font-size: var(--text-base);
  font-weight: 600;
}

/* Secondary link */
.onboarding-secondary {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: center;
  padding: var(--space-3);
  background: none;
  border: none;
}

/* Example pill */
.example-pill {
  padding: var(--space-2) var(--space-3);
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 20px;
  font-family: 'DM Sans';
  font-size: var(--text-sm);
}
```

---

## Navigation

- No back button on screen 1
- Back button appears on subsequent screens
- Progress indicator optional (simple dots, not animated bar)
- Skip is not offered—complete the flow or leave
