# Animation Guidelines

## Philosophy

Animation should communicate state change and provide feedback—not entertain. If you can remove an animation and the UX still works, it should probably be removed.

---

## Allowed Animations

| Element            | Animation                 | Duration | Easing               |
|--------------------|---------------------------|----------|----------------------|
| Button press       | Scale to 0.97             | 100ms    | ease-out             |
| Card selection     | Border color, scale 0.98  | 150ms    | spring (damping: 15) |
| Screen transitions | Fade + slight translate-y | 250ms    | ease-in-out          |
| Pool liquid level  | Spring to target          | 800ms    | spring (damping: 12) |
| Pool surface wave  | Translate-y oscillation   | 8000ms   | linear (loop)        |
| List item entrance | Fade-in + translate-y     | 200ms    | ease-out, 50ms stagger |
| Modal open         | Fade + scale from 0.95    | 200ms    | ease-out             |
| Toggle             | Spring flip               | 200ms    | spring               |

---

## Forbidden Animations

- Bouncing elements
- Rotating or spinning loaders (use simple pulse or fade)
- Confetti or particle explosions
- Parallax scrolling effects
- Entrance animations longer than 300ms
- Looping animations (except pool surface)
- Bezier curves with dramatic overshoot

---

## Implementation Examples

### Button Press

```jsx
const buttonAnimation = {
  whileTap: { scale: 0.97 },
  transition: { duration: 0.1, ease: 'easeOut' }
};
```

### Card Selection

```jsx
const cardAnimation = {
  whileTap: { scale: 0.98 },
  transition: {
    type: 'spring',
    damping: 15,
    stiffness: 300
  }
};
```

### Pool Liquid Level

```jsx
const poolAnimation = {
  animate: { height: `${level}%` },
  transition: {
    type: 'spring',
    damping: 12,
    stiffness: 100
  }
};
```

### Pool Surface Wave

```css
@keyframes wave {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

.pool-surface {
  animation: wave 8s linear infinite;
}
```

### List Item Stagger

```jsx
const listAnimation = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: (index) => ({
    delay: index * 0.05,
    duration: 0.2,
    ease: 'easeOut'
  })
};
```

### Modal Open

```jsx
const modalAnimation = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.2, ease: 'easeOut' }
};
```

---

## Reduced Motion

Respect `prefers-reduced-motion`. When enabled:

- All springs become linear
- Pool wave disabled
- Entrance animations become instant fades
- Keep functional feedback (button press) but simplify

### Implementation

```jsx
import { useReducedMotion } from 'framer-motion';

function AnimatedComponent() {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1 }}
      transition={shouldReduceMotion
        ? { duration: 0 }
        : { duration: 0.2, type: 'spring' }
      }
    />
  );
}
```

### CSS Approach

```css
@media (prefers-reduced-motion: reduce) {
  .pool-surface {
    animation: none;
  }

  * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

---

## Performance Notes

- Always use `transform` and `opacity` for animations (GPU-accelerated)
- Avoid animating `width`, `height`, `top`, `left` (triggers layout)
- Use `will-change` sparingly and only on elements that will animate
- Target 60fps for all animations
- Use native driver in React Native (Reanimated 3)
