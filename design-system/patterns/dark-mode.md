# Dark Mode

Not an inversion—a considered parallel palette.

---

## Dark Mode Palette

```css
/* Backgrounds */
--bg-primary:     #1C1C1A      /* Warm near-black */
--bg-secondary:   #2C2C28      /* Card backgrounds */
--bg-tertiary:    #3C3C38      /* Elevated surfaces */

/* Text */
--text-primary:   #FAFAF8      /* Off-white */
--text-secondary: #A8A8A0      /* Muted */
--text-tertiary:  #6B6B63      /* Hints */

/* Accents (brighter for dark backgrounds) */
--accent-action:  #3B82F6      /* Slightly brighter blue */
--accent-success: #22C55E      /* Brighter green */
--accent-warning: #F59E0B      /* Brighter amber */
--accent-danger:  #EF4444      /* Brighter red */

/* Pool */
--pool-full:      #93C5FD      /* Lighter luminous blue */
--pool-glow:      rgba(147, 197, 253, 0.1)
```

---

## Design Rules

### 1. Elevation = Lightness

In dark mode, higher surfaces are lighter (opposite of light mode shadow logic).

```
Base layer:     #1C1C1A (darkest)
Card:           #2C2C28 (slightly lighter)
Modal:          #3C3C38 (lightest)
```

### 2. No Pure Black

`#1C1C1A` has warmth. Pure black (`#000000`) feels like OLED burn-in territory and is harsh on the eyes.

### 3. Accent Colors Brighten

Colors need more saturation/brightness to pop against dark backgrounds:

| Light Mode | Dark Mode | Change |
|------------|-----------|--------|
| `#2563EB`  | `#3B82F6` | +brightness |
| `#16A34A`  | `#22C55E` | +brightness |
| `#D97706`  | `#F59E0B` | +brightness |
| `#DC2626`  | `#EF4444` | +brightness |

### 4. Reduce Contrast Slightly

White text on black is harsher than off-white on near-black:

- Use `#FAFAF8` instead of `#FFFFFF`
- Softer on the eyes, especially at night

---

## Implementation

### CSS Custom Properties

```css
:root {
  /* Light mode (default) */
  --bg-primary: #FAFAF8;
  --bg-secondary: #F5F5F3;
  --bg-tertiary: #EDEDE9;
  --text-primary: #1C1C1A;
  --text-secondary: #6B6B63;
  --text-tertiary: #9C9C94;
  --accent-action: #2563EB;
  /* ... */
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #1C1C1A;
    --bg-secondary: #2C2C28;
    --bg-tertiary: #3C3C38;
    --text-primary: #FAFAF8;
    --text-secondary: #A8A8A0;
    --text-tertiary: #6B6B63;
    --accent-action: #3B82F6;
    /* ... */
  }
}
```

### React Native

```jsx
import { useColorScheme } from 'react-native';

const colors = {
  light: {
    bgPrimary: '#FAFAF8',
    bgSecondary: '#F5F5F3',
    bgTertiary: '#EDEDE9',
    textPrimary: '#1C1C1A',
    textSecondary: '#6B6B63',
    textTertiary: '#9C9C94',
    accentAction: '#2563EB',
    accentSuccess: '#16A34A',
    accentWarning: '#D97706',
    accentDanger: '#DC2626',
    poolFull: '#60A5FA',
    poolGlow: 'rgba(96, 165, 250, 0.15)',
  },
  dark: {
    bgPrimary: '#1C1C1A',
    bgSecondary: '#2C2C28',
    bgTertiary: '#3C3C38',
    textPrimary: '#FAFAF8',
    textSecondary: '#A8A8A0',
    textTertiary: '#6B6B63',
    accentAction: '#3B82F6',
    accentSuccess: '#22C55E',
    accentWarning: '#F59E0B',
    accentDanger: '#EF4444',
    poolFull: '#93C5FD',
    poolGlow: 'rgba(147, 197, 253, 0.1)',
  },
};

function useThemeColors() {
  const scheme = useColorScheme();
  return colors[scheme ?? 'light'];
}
```

### Context Provider

```jsx
const ThemeContext = createContext(colors.light);

function ThemeProvider({ children }) {
  const scheme = useColorScheme();
  const theme = colors[scheme ?? 'light'];

  return (
    <ThemeContext.Provider value={theme}>
      {children}
    </ThemeContext.Provider>
  );
}

function useTheme() {
  return useContext(ThemeContext);
}
```

---

## Component Adjustments

### Shadows

In dark mode, shadows are less visible. Use subtle borders instead:

```css
/* Light mode */
.card {
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .card {
    box-shadow: none;
    border: 1px solid var(--bg-tertiary);
  }
}
```

### Pool Glow

Reduce glow intensity in dark mode to prevent harshness:

```css
.pool-glow {
  background: var(--pool-glow);
  /* Light: rgba(96, 165, 250, 0.15) */
  /* Dark: rgba(147, 197, 253, 0.1) - less intense */
}
```

### Dividers

Use lighter color for dividers:

```css
.divider {
  background: var(--bg-tertiary);
  /* Automatically adjusts: #EDEDE9 → #3C3C38 */
}
```

---

## Testing Checklist

- [ ] All text meets WCAG AA contrast (4.5:1)
- [ ] Accent colors are visible against dark backgrounds
- [ ] No pure white or pure black anywhere
- [ ] Elevated surfaces are visually distinct
- [ ] Pool visualization is clear and readable
- [ ] Buttons and interactive elements stand out
- [ ] Images/icons don't clash with dark background
- [ ] Status bar adapts to theme
