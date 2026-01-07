# Spacing System

## Scale

```css
--space-0:    0
--space-1:    4px     /* Tight grouping (icon + label) */
--space-2:    8px     /* Related elements */
--space-3:    12px    /* Standard padding */
--space-4:    16px    /* Card padding */
--space-5:    24px    /* Section separation */
--space-6:    32px    /* Major sections */
--space-7:    48px    /* Screen sections */
--space-8:    64px    /* Hero spacing */
```

---

## Philosophy

**More space = more importance.**

The pool visualization gets generous whitespace around it. Dense lists get tighter spacing. This creates natural visual hierarchy without decorative elements.

---

## Application Guide

### Tight Grouping (`--space-1`: 4px)

Use between an icon and its label, or tightly related inline elements.

```
[icon]·[label]
```

### Related Elements (`--space-2`: 8px)

Use between elements that belong together but need some breathing room.

```
[Habit name]
        ↕ 8px
[2-minute version text]
```

### Standard Padding (`--space-3`: 12px)

Default internal padding for compact components.

```
┌──────────────────┐
│  ←12px→ Text     │
└──────────────────┘
```

### Card Padding (`--space-4`: 16px)

Standard padding inside cards and containers.

```
┌────────────────────────┐
│                        │
│  ←16px→ Content ←16px→ │
│                        │
└────────────────────────┘
```

### Section Separation (`--space-5`: 24px)

Gap between related sections within a screen.

```
[TODAY'S INTENTION]
[Card content]
        ↕ 24px
[HABITS]
[Habit list]
```

### Major Sections (`--space-6`: 32px)

Larger gaps for major screen divisions.

### Screen Sections (`--space-7`: 48px)

Top/bottom padding for major screen areas.

### Hero Spacing (`--space-8`: 64px)

Reserved for the pool visualization and other hero elements that need maximum visual weight.

---

## Practical Examples

### Home Screen Spacing

```
┌─────────────────────────────────────────────────┐
│  STATUS BAR                                     │
├─────────────────────────────────────────────────┤
│                     ↑                           │
│                  space-7 (48px)                 │
│                     ↓                           │
│  Good morning.                                  │
│  Tuesday, January 6                             │
│                     ↑                           │
│                  space-6 (32px)                 │
│                     ↓                           │
│  ┌───────────────────────────────────────────┐  │
│  │         [DOPAMINE POOL]                   │  │
│  │           ← space-8 around pool →         │  │
│  └───────────────────────────────────────────┘  │
│                     ↑                           │
│                  space-6 (32px)                 │
│                     ↓                           │
│  TODAY'S INTENTION                              │
│       ↕ space-3 (12px)                          │
│  ┌───────────────────────────────────────────┐  │
│  │  [Primary task card]   ← space-4 padding  │  │
│  └───────────────────────────────────────────┘  │
│                     ↑                           │
│                  space-5 (24px)                 │
│                     ↓                           │
│  HABITS                                         │
│       ↕ space-3 (12px)                          │
│  ┌───────────────────────────────────────────┐  │
│  │  [Habit 1]                                │  │
│  ├───────────────────────────────────────────┤  │
│  │  [Habit 2]                                │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### List Item Spacing

```
┌───────────────────────────────────────────────────┐
│                                                   │
│ ←16px→ Morning Walk                    ○ ○ ● ←16→ │
│        ↕ 4px                                      │
│ ←16px→ 2-min: Put on shoes            12 days    │
│                                                   │
└───────────────────────────────────────────────────┘
         ↕ 1px divider
┌───────────────────────────────────────────────────┐
│  [Next habit...]                                  │
└───────────────────────────────────────────────────┘
```
