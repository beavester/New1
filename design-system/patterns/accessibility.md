# Accessibility

## Minimum Requirements

| Requirement | Target |
|-------------|--------|
| Touch targets | 44pt minimum (48pt preferred) |
| Color contrast | WCAG AA (4.5:1 text, 3:1 UI) |
| Focus states | Visible focus rings for keyboard/VoiceOver |
| Dynamic Type | Support up to xxxLarge (iOS) |
| Screen reader | Labels on all interactive elements |
| Reduced motion | Respect OS setting |

---

## Touch Targets

All interactive elements must be at least 44×44 points:

```css
.button,
.touchable {
  min-width: 44px;
  min-height: 44px;
}

/* Even if visually smaller, expand hit area */
.icon-button {
  width: 24px;
  height: 24px;
  padding: 10px; /* Expands to 44px total */
}
```

### Tab Bar Items

```css
.tab-item {
  min-width: 64px;
  min-height: 44px;
  padding: var(--space-2);
}
```

---

## Color Contrast

### Text on Backgrounds

| Combination | Contrast Ratio | Pass |
|-------------|---------------|------|
| `--text-primary` on `--bg-primary` | 12.6:1 | ✓ AAA |
| `--text-secondary` on `--bg-primary` | 5.2:1 | ✓ AA |
| `--text-tertiary` on `--bg-primary` | 3.5:1 | ✓ UI only |
| `--accent-action` on `--bg-primary` | 4.8:1 | ✓ AA |
| White on `--accent-action` | 5.7:1 | ✓ AA |

### Never Rely on Color Alone

Always pair color with another indicator:

```jsx
// ❌ Bad: Only color indicates state
<Dot color={completed ? 'green' : 'gray'} />

// ✓ Good: Color + fill pattern
<Dot filled={completed} color={completed ? 'green' : 'gray'} />
```

---

## Focus States

Visible focus rings for keyboard and VoiceOver navigation:

```css
.focusable:focus-visible {
  outline: 2px solid var(--accent-action);
  outline-offset: 2px;
}

/* Remove default outline only if custom provided */
.focusable:focus {
  outline: none;
}
.focusable:focus-visible {
  outline: 2px solid var(--accent-action);
  outline-offset: 2px;
}
```

### React Native

```jsx
<Pressable
  accessibilityRole="button"
  accessible={true}
  style={({ focused }) => [
    styles.button,
    focused && styles.buttonFocused
  ]}
>
```

---

## Screen Reader Labels

### Buttons

```jsx
<TouchableOpacity
  accessibilityLabel="Mark habit complete"
  accessibilityHint="Double tap to mark Morning Walk as done"
  accessibilityRole="button"
>
  <CheckIcon />
</TouchableOpacity>
```

### Status Indicators

```jsx
<View
  accessibilityLabel={`Pool level: ${level}%. ${getLabel(level)}`}
  accessibilityRole="progressbar"
  accessibilityValue={{
    min: 0,
    max: 100,
    now: level,
    text: `${level}%`
  }}
>
  <DopaminePool level={level} />
</View>
```

### Habit Card

```jsx
<View
  accessibilityLabel={`${habit.name}. ${habit.streak} day streak. ${
    habit.completedToday ? 'Completed today' : 'Not completed today'
  }`}
  accessibilityRole="button"
  accessibilityHint="Double tap to view habit details"
>
```

### Lists

```jsx
<View
  accessibilityRole="list"
  accessibilityLabel="Your habits"
>
  {habits.map((habit, index) => (
    <HabitCard
      key={habit.id}
      habit={habit}
      accessibilityRole="listitem"
      accessibilityLabel={`${index + 1} of ${habits.length}`}
    />
  ))}
</View>
```

---

## Dynamic Type (iOS)

Support system font scaling up to xxxLarge:

```jsx
import { Text, useWindowDimensions } from 'react-native';

function ScaledText({ style, ...props }) {
  const { fontScale } = useWindowDimensions();

  return (
    <Text
      style={[style, { fontSize: style.fontSize * fontScale }]}
      allowFontScaling={true}
      maxFontSizeMultiplier={1.5} // Cap at 150% to prevent layout breaks
      {...props}
    />
  );
}
```

### Layout Considerations

- Use flexible layouts that accommodate larger text
- Don't truncate critical information
- Test at 200% font scale

---

## Reduced Motion

Respect `prefers-reduced-motion`:

### CSS

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### React Native

```jsx
import { AccessibilityInfo } from 'react-native';

function useReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion
    );

    return () => subscription.remove();
  }, []);

  return reduceMotion;
}
```

### Animation Adjustments

```jsx
function AnimatedComponent() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion
        ? { duration: 0 }
        : { type: 'spring', damping: 15 }
      }
    />
  );
}
```

---

## ADHD-Specific Considerations

These aren't just accessibility—they're core to our design philosophy:

### 1. One Primary Action Per Screen

Don't compete for attention. Make the next action obvious.

```
✓ Home screen: Pool + single intention card
✗ Home screen: Pool + intention + goals + stats + tips
```

### 2. Clear State Communication

Always know what's done vs. pending:

```
✓ Filled dot = done, empty dot = not done
✓ Green left border = completed today
✗ Ambiguous gray states
```

### 3. Consistent Layout

Don't move elements between sessions:

```
✓ Pool always at top of home screen
✓ Tab bar always at bottom
✗ Dynamic reordering based on "relevance"
```

### 4. No Timers or Countdowns

Time pressure increases anxiety. Avoid unless explicitly requested:

```
✓ "Day 23 of 60" (static progress)
✗ "23 days remaining!" with countdown
✗ Streaks with "don't break it!" pressure
```

### 5. Undo Everything

Mistakes shouldn't be permanent:

```
✓ "Marked complete" with "Undo" toast
✓ "Paused habit" with "Resume" option
✗ Immediate permanent deletion
```

---

## Testing Checklist

### Manual Testing

- [ ] Navigate entire app with VoiceOver (iOS) or TalkBack (Android)
- [ ] Complete all flows using keyboard only
- [ ] Test at 200% font scale
- [ ] Test with reduced motion enabled
- [ ] Test with high contrast mode
- [ ] Verify all touch targets are 44pt+

### Automated Testing

```jsx
// Jest + React Native Testing Library
it('has accessible labels', () => {
  const { getByLabelText } = render(<HabitCard habit={mockHabit} />);

  expect(getByLabelText(/Morning Walk/)).toBeTruthy();
  expect(getByLabelText(/12 day streak/)).toBeTruthy();
});
```

### Contrast Checking Tools

- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Stark](https://www.getstark.co/) (Figma plugin)
- Xcode Accessibility Inspector
