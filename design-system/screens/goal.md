# Goal / Curriculum Screen

Displays the user's main goal and their progress through the AI-generated curriculum.

## Layout

```
┌─────────────────────────────────────────────────┐
│  Your Goal                              Edit    │
├─────────────────────────────────────────────────┤
│                                                 │
│  "Run a 5K without stopping"                    │
│                                                 │
│  Day 23 of 60                                   │
│  ═══════════════════════○─────────────────────  │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│  THIS WEEK: ENDURANCE BUILDING                  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  Mon   25-min run: jog 4/walk 1 ×5    ●   │  │
│  │  Tue   Rest day                       ○   │  │
│  │  Wed   25-min run: jog 4/walk 1 ×5    ●   │  │
│  │  Thu   Cross-training (your choice)   ○   │  │
│  │  Fri   30-min run: jog 5/walk 1 ×5    ○   │  │
│  │  Sat   Long run: 35 min easy pace     ○   │  │
│  │  Sun   Rest day                       ○   │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  UPCOMING WEEKS                                 │
│  Week 4: Extend continuous jog to 8 min        │
│  Week 5: Build to 2K without walking           │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Header

```css
.goal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-5);
  padding-top: var(--space-7);
}

.goal-title {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
}

.edit-button {
  font-family: 'DM Sans';
  font-size: var(--text-base);
  color: var(--accent-action);
  background: none;
  border: none;
}
```

---

## Goal Statement

The user's goal, displayed prominently in quotes:

```css
.goal-statement {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
  padding: var(--space-5);
  padding-top: 0;
}

/* Quotation marks */
.goal-statement::before {
  content: '"';
}
.goal-statement::after {
  content: '"';
}
```

---

## Progress Bar

Simple line progress indicator:

```
Day 23 of 60
═══════════════════════○─────────────────────
```

### Specifications

- No gradient
- No animation (static display)
- Filled portion: `--accent-action` or `--text-primary`
- Empty portion: `--bg-tertiary`
- Current position: Circle indicator

```css
.progress-section {
  padding: 0 var(--space-5);
  margin-bottom: var(--space-6);
}

.progress-label {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.progress-bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  position: relative;
}

.progress-fill {
  height: 100%;
  background: var(--text-primary);
  border-radius: 2px;
}

.progress-indicator {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--bg-primary);
  border: 2px solid var(--text-primary);
}
```

---

## This Week Section

Current week's tasks, expanded with full details:

```css
.week-header {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  padding: var(--space-4) var(--space-5);
}

.week-title {
  font-family: 'DM Sans';
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
  padding: 0 var(--space-5);
  margin-bottom: var(--space-3);
}
```

---

## Daily Task Row

```
│  Mon   25-min run: jog 4/walk 1 ×5    ●   │
```

### Specifications

| Element    | Style                           |
|------------|---------------------------------|
| Day label  | `--text-sm`, semibold, 48px width |
| Task       | `--text-base`, `--text-primary` |
| Completion | 12px filled/empty circle        |

```css
.daily-task {
  display: flex;
  align-items: center;
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--bg-tertiary);
}

.daily-task:last-child {
  border-bottom: none;
}

.task-day {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  width: 48px;
}

.task-description {
  flex: 1;
  font-family: 'DM Sans';
  font-size: var(--text-base);
  color: var(--text-primary);
}

.task-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.task-status.completed {
  background: var(--accent-success);
}

.task-status.pending {
  border: 1.5px solid var(--text-tertiary);
  background: transparent;
}
```

---

## Upcoming Weeks

Collapsed view showing only week titles:

```css
.upcoming-section {
  padding: var(--space-5);
}

.upcoming-header {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  margin-bottom: var(--space-3);
}

.upcoming-week {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--bg-tertiary);
}

.upcoming-week-title {
  font-family: 'DM Sans';
  font-size: var(--text-base);
  color: var(--text-secondary);
}
```

---

## States

### Goal Not Set

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│         What do you want to achieve             │
│         in the next 60 days?                    │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ e.g., Run a 5K, Learn guitar basics...  │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│          ┌─────────────────────────┐            │
│          │      Create plan        │            │
│          └─────────────────────────┘            │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Generating Curriculum

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│                                                 │
│         Creating your 60-day plan...            │
│                                                 │
│         ○ ○ ○                                   │
│                                                 │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

Simple pulsing dots, no elaborate animation.

### Goal Completed

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                    ✓                            │
│                                                 │
│  "Run a 5K without stopping"                    │
│                                                 │
│         Goal completed on Jan 15                │
│                                                 │
│          ┌─────────────────────────┐            │
│          │     Set a new goal      │            │
│          └─────────────────────────┘            │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Implementation

```jsx
function GoalScreen() {
  const { goal, currentWeek, upcomingWeeks, progress } = useGoal();

  if (!goal) {
    return <GoalSetup />;
  }

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Your Goal</Text>
        <TouchableOpacity>
          <Text style={styles.editButton}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Goal Statement */}
      <Text style={styles.goalStatement}>"{goal.title}"</Text>

      {/* Progress */}
      <View style={styles.progressSection}>
        <Text style={styles.progressLabel}>
          Day {progress.current} of {progress.total}
        </Text>
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress.percentage}%` }
            ]}
          />
          <View
            style={[
              styles.progressIndicator,
              { left: `${progress.percentage}%` }
            ]}
          />
        </View>
      </View>

      {/* Current Week */}
      <View style={styles.weekSection}>
        <Text style={styles.weekHeader}>THIS WEEK</Text>
        <Text style={styles.weekTitle}>{currentWeek.title}</Text>
        <View style={styles.taskList}>
          {currentWeek.tasks.map((task, i) => (
            <View key={i} style={styles.dailyTask}>
              <Text style={styles.taskDay}>{task.day}</Text>
              <Text style={styles.taskDescription}>{task.description}</Text>
              <View
                style={[
                  styles.taskStatus,
                  task.completed ? styles.completed : styles.pending
                ]}
              />
            </View>
          ))}
        </View>
      </View>

      {/* Upcoming Weeks */}
      <View style={styles.upcomingSection}>
        <Text style={styles.upcomingHeader}>UPCOMING WEEKS</Text>
        {upcomingWeeks.map((week, i) => (
          <View key={i} style={styles.upcomingWeek}>
            <Text style={styles.upcomingWeekTitle}>
              Week {week.number}: {week.title}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
```
