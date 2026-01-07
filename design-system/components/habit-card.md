# Habit Card

A list item component for displaying individual habits with their completion status and streak.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  Morning Walk                           ○ ○ ●   │
│  2-min: Put on shoes, step outside      ─────   │
│                                         12 days │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Anatomy

### Left Side

- **Habit name:** `--text-lg`, semibold, `--text-primary`
- **2-minute version:** `--text-sm`, `--text-secondary`

### Right Side

- **Completion dots:** Last 3 days (empty/filled circles)
- **Streak count:** `--text-sm`, `--text-secondary`

---

## Visual Treatment

| Property      | Value                                    |
|---------------|------------------------------------------|
| Background    | `--bg-secondary`                         |
| Border        | 1px `--bg-tertiary` (no shadows)         |
| Border radius | 8px (subtle rounding, not pills)         |
| Padding       | `--space-4` (16px)                       |
| Min height    | 72px                                     |

---

## States

### Default

```css
.habit-card {
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
}
```

### Hover

```css
.habit-card:hover {
  background: var(--bg-tertiary);
}
```

### Active / Pressed

```css
.habit-card:active {
  transform: scale(0.98);
  transition: transform 150ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
```

### Completed (Today)

```css
.habit-card.completed {
  border-left: 4px solid var(--accent-success);
}
```

---

## Completion Dots

Visual representation of the last 3 days:

```
○ ○ ●
↑ ↑ ↑
│ │ └─ Today (filled = done)
│ └─── Yesterday
└───── 2 days ago
```

### Dot Styles

```css
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: var(--space-1);
}

.dot.empty {
  border: 1.5px solid var(--text-tertiary);
  background: transparent;
}

.dot.filled {
  background: var(--accent-success);
  border: none;
}
```

---

## Anti-patterns

- NO checkbox with circle-to-checkmark animation
- NO confetti on completion
- NO progress rings
- NO achievement badges
- NO colored category indicators
- NO icons for habit types

---

## Expanded State

When tapped, the habit card can expand to show more details:

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  Morning Walk                           ○ ○ ●   │
│  2-min: Put on shoes, step outside      ─────   │
│                                         12 days │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│  This week                                      │
│  ● ● ● ○ ● ● ●                                 │
│  M T W T F S S                                  │
│                                                 │
│  [Edit]                            [Pause]      │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Implementation

```jsx
function HabitCard({ habit, onComplete, onExpand }) {
  const { name, twoMinVersion, lastThreeDays, streak, completedToday } = habit;

  return (
    <motion.button
      className={`habit-card ${completedToday ? 'completed' : ''}`}
      onClick={onExpand}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', damping: 15 }}
    >
      <div className="habit-left">
        <span className="habit-name">{name}</span>
        <span className="habit-two-min">2-min: {twoMinVersion}</span>
      </div>

      <div className="habit-right">
        <div className="completion-dots">
          {lastThreeDays.map((done, i) => (
            <span key={i} className={`dot ${done ? 'filled' : 'empty'}`} />
          ))}
        </div>
        <span className="streak">{streak} days</span>
      </div>
    </motion.button>
  );
}
```

```css
.habit-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}

.habit-card.completed {
  border-left: 4px solid var(--accent-success);
}

.habit-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.habit-name {
  font-family: 'DM Sans';
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.habit-two-min {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.habit-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
}

.completion-dots {
  display: flex;
  gap: var(--space-1);
}

.streak {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
```
