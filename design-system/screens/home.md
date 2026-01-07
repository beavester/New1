# Home Screen (Today View)

The primary screen users see when opening the app. Displays the dopamine pool, today's intention, and habits at a glance.

## Layout

```
┌─────────────────────────────────────────────────┐
│  STATUS BAR                                     │
├─────────────────────────────────────────────────┤
│                                                 │
│  Good morning.                                  │
│  Tuesday, January 6                             │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │              [DOPAMINE POOL]              │  │
│  │                   72%                     │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  TODAY'S INTENTION                              │
│  ┌───────────────────────────────────────────┐  │
│  │  [Primary task card]                      │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  HABITS                                         │
│  ┌───────────────────────────────────────────┐  │
│  │  [Habit 1]                        ○ ○ ●   │  │
│  ├───────────────────────────────────────────┤  │
│  │  [Habit 2]                        ● ○ ●   │  │
│  ├───────────────────────────────────────────┤  │
│  │  [Habit 3]                        ● ● ●   │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
├─────────────────────────────────────────────────┤
│  [TAB BAR]                                      │
└─────────────────────────────────────────────────┘
```

---

## Visual Hierarchy

1. **Pool is the hero.** Largest element, centered, generous padding (`--space-8` around it).
2. **Today's intention** is the primary action. Visually distinct card with subtle shadow.
3. **Habits** are secondary—scannable list, not competing for attention.

---

## Greeting

Dynamic greeting based on time of day:

| Time          | Greeting        |
|---------------|-----------------|
| 5am - 12pm    | Good morning.   |
| 12pm - 5pm    | Good afternoon. |
| 5pm - 9pm     | Good evening.   |
| 9pm - 5am     | Good evening.   |

```jsx
<h1 className="greeting">Good morning.</h1>
<p className="date">Tuesday, January 6</p>
```

```css
.greeting {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
}

.date {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-1);
}
```

---

## Scroll Behavior

### Sticky Header

When scrolling, the pool shrinks to a compact version:

```
┌─────────────────────────────────────────────────┐
│  Tuesday, January 6         ┌──┐ 72%            │
│                             │██│                │
│                             └──┘                │
├─────────────────────────────────────────────────┤
│  [Content scrolls behind]                       │
```

- Pool becomes 40px tall, inline with date
- Greeting disappears
- Header becomes sticky
- List scrolls behind sticky header

### Implementation

```jsx
function HomeScreen() {
  const scrollY = useSharedValue(0);
  const headerHeight = useSharedValue(EXPANDED_HEIGHT);

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
    headerHeight.value = interpolate(
      event.contentOffset.y,
      [0, COLLAPSE_THRESHOLD],
      [EXPANDED_HEIGHT, COLLAPSED_HEIGHT],
      Extrapolate.CLAMP
    );
  });

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.header, { height: headerHeight }]}>
        <HeaderContent scrollY={scrollY} />
      </Animated.View>

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: EXPANDED_HEIGHT }}
      >
        {/* Content */}
      </Animated.ScrollView>
    </View>
  );
}
```

---

## Section Labels

```css
.section-label {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  margin-bottom: var(--space-3);
}
```

---

## Spacing Breakdown

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
│  [DOPAMINE POOL with space-8 padding]           │
│                     ↑                           │
│                  space-6 (32px)                 │
│                     ↓                           │
│  TODAY'S INTENTION (section label)              │
│       ↕ space-3 (12px)                          │
│  [Intention card]                               │
│                     ↑                           │
│                  space-5 (24px)                 │
│                     ↓                           │
│  HABITS (section label)                         │
│       ↕ space-3 (12px)                          │
│  [Habit list]                                   │
│                     ↑                           │
│                  space-7 (48px) + tab bar       │
│                     ↓                           │
└─────────────────────────────────────────────────┘
```

---

## Empty States

### No Intention Set

```
┌───────────────────────────────────────────┐
│                                           │
│   What's your focus for today?            │
│                                           │
│   ┌─────────────────────────────────┐     │
│   │      Set today's intention      │     │
│   └─────────────────────────────────┘     │
│                                           │
└───────────────────────────────────────────┘
```

### No Habits Yet

```
┌───────────────────────────────────────────┐
│                                           │
│   No habits yet.                          │
│   Start with just one.                    │
│                                           │
│   ┌─────────────────────────────────┐     │
│   │         Add first habit         │     │
│   └─────────────────────────────────┘     │
│                                           │
└───────────────────────────────────────────┘
```

---

## Full Implementation

```jsx
function HomeScreen() {
  const { pool, intention, habits } = useHomeData();
  const greeting = useGreeting();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {/* Greeting */}
      <View style={styles.header}>
        <Text style={styles.greeting}>{greeting}</Text>
        <Text style={styles.date}>{formatDate(new Date())}</Text>
      </View>

      {/* Dopamine Pool */}
      <View style={styles.poolSection}>
        <DopaminePool level={pool.level} />
      </View>

      {/* Today's Intention */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>TODAY'S INTENTION</Text>
        {intention ? (
          <IntentionCard task={intention} />
        ) : (
          <EmptyIntention />
        )}
      </View>

      {/* Habits */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>HABITS</Text>
        {habits.length > 0 ? (
          <View style={styles.habitList}>
            {habits.map(habit => (
              <HabitCard key={habit.id} habit={habit} />
            ))}
          </View>
        ) : (
          <EmptyHabits />
        )}
      </View>
    </ScrollView>
  );
}
```

```css
.container {
  flex: 1;
  background: var(--bg-primary);
}

.content {
  padding-bottom: calc(80px + env(safe-area-inset-bottom));
}

.header {
  padding: var(--space-7) var(--space-5) var(--space-6);
}

.greeting {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
}

.date {
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-1);
}

.poolSection {
  padding: var(--space-8) var(--space-5);
}

.section {
  padding: 0 var(--space-5);
  margin-bottom: var(--space-5);
}

.sectionLabel {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  margin-bottom: var(--space-3);
}

.habitList {
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}
```
