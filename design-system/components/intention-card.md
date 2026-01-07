# Today's Intention (Primary CTA Area)

The main action card that displays the user's primary task for the day.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│                                                 │
│         What's the one thing today?             │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │   Complete Week 3 curriculum task         │  │
│  │   20-min run: jog 3 min, walk 1 min ×5    │  │
│  │                                           │  │
│  │   ┌─────────────────────────────────┐     │  │
│  │   │          Mark Complete          │     │  │
│  │   └─────────────────────────────────┘     │  │
│  │                                           │  │
│  │   Can't start? Get the 2-minute version   │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Anatomy

### Question Header

- Text: "What's the one thing today?"
- Font: Instrument Serif, `--text-xl`
- Color: `--text-primary`

### Task Card

- Elevated container with subtle shadow
- Contains task name, details, and actions

### Primary Action

- "Mark Complete" button
- Full-width within card
- Prominent styling

### Secondary Action

- "Can't start? Get the 2-minute version"
- Text link, not a button
- Fallback option for resistance

---

## Visual Treatment

### Question

```css
.intention-question {
  font-family: 'Instrument Serif';
  font-size: var(--text-xl);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}
```

### Task Card

```css
.intention-card {
  background: var(--bg-primary);
  border-radius: 12px;
  padding: var(--space-5);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
```

### Primary Button

```css
.mark-complete-btn {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--accent-action);
  color: white;
  border: none;
  border-radius: 8px;
  font-family: 'DM Sans';
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
}
```

### Secondary Link

```css
.two-min-link {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
```

---

## Animations

### Button Press

```jsx
whileTap={{ scale: 0.97 }}
transition={{ duration: 0.1 }}
```

### Success State

On completion:

1. Button text changes to "Done ✓"
2. Background fades to `--accent-success`
3. After 500ms, card slides away

```jsx
const successAnimation = {
  initial: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -100 },
  transition: { duration: 0.3, ease: 'easeIn' }
};
```

---

## States

### Default

Task is pending, ready to be completed.

### In Progress

If task has a timer or is multi-step, show progress indicator.

### Completed

Card animates out, replaced by next intention or empty state.

### No Intention Set

```
┌───────────────────────────────────────────┐
│                                           │
│   No intention set for today.             │
│                                           │
│   ┌─────────────────────────────────┐     │
│   │      Set today's intention      │     │
│   └─────────────────────────────────┘     │
│                                           │
└───────────────────────────────────────────┘
```

---

## Implementation

```jsx
function IntentionCard({ task, onComplete, onGetTwoMin }) {
  const [completing, setCompleting] = useState(false);

  const handleComplete = async () => {
    setCompleting(true);
    await onComplete();
  };

  return (
    <section className="intention-section">
      <h2 className="intention-question">
        What's the one thing today?
      </h2>

      <AnimatePresence>
        {task && (
          <motion.div
            className="intention-card"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, x: -100 }}
          >
            <h3 className="task-name">{task.name}</h3>
            <p className="task-details">{task.details}</p>

            <motion.button
              className={`mark-complete-btn ${completing ? 'success' : ''}`}
              onClick={handleComplete}
              whileTap={{ scale: 0.97 }}
              disabled={completing}
            >
              {completing ? 'Done ✓' : 'Mark Complete'}
            </motion.button>

            <button className="two-min-link" onClick={onGetTwoMin}>
              Can't start? Get the 2-minute version
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
```

```css
.intention-section {
  padding: var(--space-5);
}

.intention-question {
  font-family: 'Instrument Serif';
  font-size: var(--text-xl);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}

.intention-card {
  background: var(--bg-primary);
  border-radius: 12px;
  padding: var(--space-5);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.task-name {
  font-family: 'DM Sans';
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.task-details {
  font-size: var(--text-base);
  color: var(--text-secondary);
}

.mark-complete-btn {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--accent-action);
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.3s ease;
}

.mark-complete-btn.success {
  background: var(--accent-success);
}

.two-min-link {
  align-self: center;
  background: none;
  border: none;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-decoration: underline;
  cursor: pointer;
}
```
