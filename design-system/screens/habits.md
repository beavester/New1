# Habits Screen (Full Tracker)

The complete habit tracking view with week grid and management options.

> **Note:** This screen is only unlocked after day 60, or accessible via "Preview Tracker" in settings.

## Layout

```
┌─────────────────────────────────────────────────┐
│  Habits                               + Add     │
├─────────────────────────────────────────────────┤
│                                                 │
│  ACTIVE (3)                                     │
│  ┌───────────────────────────────────────────┐  │
│  │  Morning Walk                    12 days  │  │
│  │  ● ● ● ○ ● ● ●                           │  │
│  ├───────────────────────────────────────────┤  │
│  │  Read 10 pages                    8 days  │  │
│  │  ● ○ ● ● ○ ● ●                           │  │
│  ├───────────────────────────────────────────┤  │
│  │  Meditate                         3 days  │  │
│  │  ● ● ●                                   │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  PAUSED (1)                                     │
│  ┌───────────────────────────────────────────┐  │
│  │  Learn Spanish                   paused   │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Header

```css
.habits-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-5);
  padding-top: var(--space-7);
}

.habits-title {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
}

.add-button {
  font-family: 'DM Sans';
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--accent-action);
  background: none;
  border: none;
  padding: var(--space-2);
}
```

---

## The Week Grid

7 dots representing the last 7 days:

```
● ● ● ○ ● ● ●
M T W T F S S
```

### Specifications

- Rolling week (last 7 days) or fixed week (Mon-Sun)
- Filled dot = completed
- Empty dot = missed
- No color coding beyond filled/empty (simplicity)

```css
.week-grid {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.week-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.week-dot.filled {
  background: var(--accent-success);
}

.week-dot.empty {
  border: 1.5px solid var(--text-tertiary);
  background: transparent;
}

.week-dot.today {
  /* Today's dot can have a subtle ring */
  box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 3px var(--text-tertiary);
}
```

---

## Habit List Item (Expanded View)

```
┌───────────────────────────────────────────────────┐
│                                                   │
│  Morning Walk                           12 days   │
│  2-min: Put on shoes, step outside                │
│                                                   │
│  ● ● ● ○ ● ● ●                                   │
│  M T W T F S S                                    │
│                                                   │
└───────────────────────────────────────────────────┘
```

### Specifications

| Element       | Style                              |
|---------------|------------------------------------|
| Habit name    | `--text-lg`, semibold              |
| 2-min version | `--text-sm`, `--text-secondary`    |
| Streak        | `--text-sm`, `--text-secondary`    |
| Week dots     | 10px circles, 8px gap              |
| Day labels    | `--text-xs`, `--text-tertiary`     |

---

## Section Headers

```css
.section-header {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  padding: var(--space-4) var(--space-5);
}
```

---

## Habit States

### Active

Normal display with week grid and streak count.

### Paused

```css
.habit-card.paused {
  opacity: 0.6;
}

.habit-card.paused .streak {
  content: 'paused';
  color: var(--text-tertiary);
}
```

### Completed Today

```css
.habit-card.completed-today {
  border-left: 4px solid var(--accent-success);
}
```

---

## Expanded Detail View

Tap habit row to expand and show stats + actions:

```
┌───────────────────────────────────────────────────┐
│                                                   │
│  Morning Walk                           12 days   │
│  2-min: Put on shoes, step outside                │
│                                                   │
│  ● ● ● ○ ● ● ●                                   │
│  M T W T F S S                                    │
│                                                   │
│  ─────────────────────────────────────────────    │
│                                                   │
│  STATS                                            │
│  Started: Dec 25, 2024                            │
│  Longest streak: 15 days                          │
│  Completion rate: 87%                             │
│                                                   │
│  ┌─────────────┐          ┌─────────────────┐     │
│  │    Edit     │          │      Pause      │     │
│  └─────────────┘          └─────────────────┘     │
│                                                   │
└───────────────────────────────────────────────────┘
```

---

## Add Habit Flow

Triggered by "+ Add" button:

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  New Habit                               ✕      │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│  What habit do you want to build?               │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ e.g., Morning walk, Read, Meditate      │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│                                                 │
│                                                 │
│          ┌─────────────────────────┐            │
│          │        Continue         │            │
│          └─────────────────────────┘            │
│                                                 │
└─────────────────────────────────────────────────┘
```

After entering habit name → auto-generate 2-minute version.

---

## Empty State

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│                                                 │
│         You haven't added any habits yet.       │
│                                                 │
│         Start small. One habit is enough.       │
│                                                 │
│          ┌─────────────────────────┐            │
│          │     Add your first      │            │
│          └─────────────────────────┘            │
│                                                 │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Implementation

```jsx
function HabitsScreen() {
  const { activeHabits, pausedHabits } = useHabits();
  const [expandedId, setExpandedId] = useState(null);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Habits</Text>
        <TouchableOpacity style={styles.addButton}>
          <Text style={styles.addButtonText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView>
        {/* Active Habits */}
        {activeHabits.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>
              ACTIVE ({activeHabits.length})
            </Text>
            <View style={styles.habitList}>
              {activeHabits.map(habit => (
                <HabitListItem
                  key={habit.id}
                  habit={habit}
                  expanded={expandedId === habit.id}
                  onPress={() => setExpandedId(
                    expandedId === habit.id ? null : habit.id
                  )}
                />
              ))}
            </View>
          </View>
        )}

        {/* Paused Habits */}
        {pausedHabits.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>
              PAUSED ({pausedHabits.length})
            </Text>
            <View style={styles.habitList}>
              {pausedHabits.map(habit => (
                <HabitListItem
                  key={habit.id}
                  habit={habit}
                  paused
                />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function HabitListItem({ habit, expanded, paused, onPress }) {
  const { name, twoMinVersion, weekData, streak } = habit;

  return (
    <TouchableOpacity
      style={[
        styles.habitItem,
        paused && styles.habitItemPaused,
        habit.completedToday && styles.habitItemCompleted
      ]}
      onPress={onPress}
    >
      <View style={styles.habitHeader}>
        <View>
          <Text style={styles.habitName}>{name}</Text>
          <Text style={styles.habitTwoMin}>2-min: {twoMinVersion}</Text>
        </View>
        <Text style={styles.streak}>
          {paused ? 'paused' : `${streak} days`}
        </Text>
      </View>

      {!paused && (
        <View style={styles.weekGrid}>
          {weekData.map((completed, i) => (
            <View
              key={i}
              style={[
                styles.weekDot,
                completed ? styles.weekDotFilled : styles.weekDotEmpty
              ]}
            />
          ))}
        </View>
      )}

      {expanded && <HabitDetails habit={habit} />}
    </TouchableOpacity>
  );
}
```
