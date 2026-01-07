# Dopamine Pool (Hero Component)

The central visualization of the Ascent app. Represents the user's current energy/motivation state.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│           ╭──────────────────────╮              │
│           │                      │              │
│           │   ░░░░░░░░░░░░░░░░   │  ← Empty    │
│           │   ░░░░░░░░░░░░░░░░   │              │
│           │   ████████████████   │  ← Liquid   │
│           │   ████████████████   │              │
│           │   ████████████████   │              │
│           ╰──────────────────────╯              │
│                                                 │
│                    72%                          │
│              "Good reserves"                    │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Visual Treatment

### Vessel

- Shape: Rounded rectangle with subtle inner shadow
- **NOT** a circle, **NOT** a pill
- Border radius: 16px
- Inner shadow: `inset 0 2px 8px rgba(0,0,0,0.08)`

### Liquid

- Flat fill with very subtle horizontal gradient (darker at bottom)
- No 3D simulation
- Color based on level (see States below)

### Animation

- **Level change:** Spring physics with slight overshoot, then settle
- **Surface wave:** CSS keyframes, 8-second loop, 1-2px amplitude
- Wave is barely perceptible—adds life without distraction

### Glow

- Optional ambient glow behind vessel when >60% full
- Color: `--pool-glow`
- Disabled in "reduced motion" mode

### Label

- Percentage: JetBrains Mono, `--text-xl`
- Qualitative label: DM Sans, `--text-sm`, `--text-secondary`

---

## States

| State    | Level   | Color            | Glow | Notes                      |
|----------|---------|------------------|------|----------------------------|
| Full     | >80%    | `--pool-full`    | Yes  | Blue-white luminous, brightest |
| Good     | 60-80%  | `--pool-mid`     | Yes  | Standard blue              |
| Depleted | 30-60%  | `--pool-low`     | No   | Deeper blue                |
| Empty    | <30%    | `--pool-depleted`| No   | Near-gray, subtle pulse warning |

---

## Qualitative Labels

| Level   | Label             |
|---------|-------------------|
| >80%    | "Full reserves"   |
| 60-80%  | "Good reserves"   |
| 40-60%  | "Getting low"     |
| 20-40%  | "Running on empty"|
| <20%    | "Rest needed"     |

---

## Compact Mode

On scroll, the pool shrinks to a compact inline version in the sticky header:

```
┌─────────────────────────────────────────────────┐
│  Tuesday, January 6         ┌──┐ 72%            │
│                             │██│                │
│                             └──┘                │
└─────────────────────────────────────────────────┘
```

- Height: 40px
- Inline with date
- No glow, no label, just percentage

---

## Anti-patterns

- NO floating bubbles
- NO particle effects
- NO neon glow
- NO gradient mesh backgrounds
- NO 3D rendering
- NO elaborate fill animations

---

## Implementation

```jsx
function DopaminePool({ level }) {
  const getColor = () => {
    if (level > 80) return 'var(--pool-full)';
    if (level > 60) return 'var(--pool-mid)';
    if (level > 30) return 'var(--pool-low)';
    return 'var(--pool-depleted)';
  };

  const getLabel = () => {
    if (level > 80) return 'Full reserves';
    if (level > 60) return 'Good reserves';
    if (level > 40) return 'Getting low';
    if (level > 20) return 'Running on empty';
    return 'Rest needed';
  };

  return (
    <div className="pool-container">
      <div className="pool-vessel">
        <motion.div
          className="pool-liquid"
          animate={{ height: `${level}%` }}
          transition={{ type: 'spring', damping: 12 }}
          style={{ backgroundColor: getColor() }}
        />
        <div className="pool-surface" />
      </div>
      <span className="pool-percentage">{level}%</span>
      <span className="pool-label">{getLabel()}</span>
    </div>
  );
}
```

```css
.pool-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-8);
}

.pool-vessel {
  width: 160px;
  height: 200px;
  border-radius: 16px;
  background: var(--bg-tertiary);
  box-shadow: inset 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.pool-liquid {
  width: 100%;
  border-radius: 0 0 12px 12px;
}

.pool-surface {
  position: absolute;
  bottom: var(--level);
  width: 100%;
  height: 4px;
  animation: wave 8s linear infinite;
}

@keyframes wave {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

.pool-percentage {
  font-family: 'JetBrains Mono';
  font-size: var(--text-xl);
  margin-top: var(--space-4);
}

.pool-label {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-1);
}
```
