# Widget Design (iOS)

## Guiding Principle

Widgets should feel like part of iOS, not a branded island. Match system aesthetics:

- SF Pro for widget text (system font)
- System backgrounds (adapts to wallpaper)
- Standard corner radii (22pt)
- No custom backgrounds or borders
- No brand colors except accent on checkmarks

---

## Widget 1: Pool Widget (Small, 2×2)

```
┌─────────────────────┐
│                     │
│       ┌────┐        │
│       │████│        │
│       │████│        │
│       │    │        │
│       └────┘        │
│        72%          │
│                     │
└─────────────────────┘
```

### Specifications

| Property | Value |
|----------|-------|
| Size | Small (2×2) |
| Pool width | 40pt |
| Pool height | 60pt |
| Percentage font | SF Pro Bold, 17pt |
| Update frequency | Every 15 minutes |
| Tap action | Opens app to Today view |

### Implementation (SwiftUI)

```swift
struct PoolWidgetEntryView: View {
    var entry: Provider.Entry

    var body: some View {
        VStack(spacing: 8) {
            // Simplified pool
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.systemGray5))
                    .frame(width: 40, height: 60)

                RoundedRectangle(cornerRadius: 6)
                    .fill(poolColor)
                    .frame(width: 36, height: CGFloat(entry.level) * 0.56)
                    .padding(.bottom, 2)
            }

            // Percentage
            Text("\(entry.level)%")
                .font(.system(size: 17, weight: .bold))
                .monospacedDigit()
        }
        .widgetURL(URL(string: "ascent://today"))
    }

    var poolColor: Color {
        switch entry.level {
        case 80...100: return Color(hex: "60A5FA")
        case 60..<80: return Color(hex: "3B82F6")
        case 30..<60: return Color(hex: "1D4ED8")
        default: return Color(hex: "1E3A5F")
        }
    }
}
```

---

## Widget 2: Action Widget (Medium, 4×2)

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  Today's intention                              │
│  Complete 20-min run                    [ ✓ ]   │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Specifications

| Property | Value |
|----------|-------|
| Size | Medium (4×2) |
| Label font | SF Pro, 13pt, secondary color |
| Task font | SF Pro, 17pt, primary color |
| Checkbox | Interactive (iOS 17+) |
| Tap task | Opens app to task detail |
| Tap checkbox | Marks complete directly |

### Implementation (SwiftUI)

```swift
struct ActionWidgetEntryView: View {
    var entry: Provider.Entry

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Today's intention")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)

                Text(entry.taskName)
                    .font(.system(size: 17))
                    .lineLimit(2)
            }

            Spacer()

            // Interactive checkbox (iOS 17+)
            if #available(iOS 17.0, *) {
                Button(intent: CompleteTaskIntent(taskId: entry.taskId)) {
                    Image(systemName: entry.completed ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 24))
                        .foregroundColor(entry.completed ? .green : .secondary)
                }
                .buttonStyle(.plain)
            } else {
                Image(systemName: entry.completed ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 24))
                    .foregroundColor(entry.completed ? .green : .secondary)
            }
        }
        .padding()
        .widgetURL(URL(string: "ascent://task/\(entry.taskId)"))
    }
}
```

---

## Widget 3: Habits Widget (Large, 4×4)

```
┌─────────────────────────────────────────────────┐
│  Habits                          Tuesday Jan 6  │
├─────────────────────────────────────────────────┤
│                                                 │
│  [ ] Morning Walk                               │
│  [✓] Read 10 pages                              │
│  [ ] Meditate                                   │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│             ┌────┐                              │
│             │████│  72%                         │
│             └────┘                              │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Specifications

| Property | Value |
|----------|-------|
| Size | Large (4×4) |
| Header | Title + date |
| Habits shown | Up to 4 |
| Checkboxes | Interactive (iOS 17+) |
| Pool | Compact inline version |
| Full tap | Opens Habits screen |

### Implementation (SwiftUI)

```swift
struct HabitsWidgetEntryView: View {
    var entry: Provider.Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Habits")
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                Text(entry.dateString)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            }
            .padding(.bottom, 12)

            // Habit list
            VStack(alignment: .leading, spacing: 8) {
                ForEach(entry.habits.prefix(4)) { habit in
                    HabitRow(habit: habit)
                }
            }

            Spacer()

            Divider()
                .padding(.vertical, 12)

            // Compact pool
            HStack {
                Spacer()
                CompactPool(level: entry.poolLevel)
                Text("\(entry.poolLevel)%")
                    .font(.system(size: 15, weight: .semibold))
                    .monospacedDigit()
                Spacer()
            }
        }
        .padding()
        .widgetURL(URL(string: "ascent://habits"))
    }
}

struct HabitRow: View {
    let habit: HabitEntry

    var body: some View {
        HStack(spacing: 12) {
            if #available(iOS 17.0, *) {
                Button(intent: ToggleHabitIntent(habitId: habit.id)) {
                    Image(systemName: habit.completed ? "checkmark.square.fill" : "square")
                        .foregroundColor(habit.completed ? .green : .secondary)
                }
                .buttonStyle(.plain)
            } else {
                Image(systemName: habit.completed ? "checkmark.square.fill" : "square")
                    .foregroundColor(habit.completed ? .green : .secondary)
            }

            Text(habit.name)
                .font(.system(size: 15))
                .lineLimit(1)
        }
    }
}
```

---

## Widget Visual Standards

### Background

Use system widget background (auto-adapts to wallpaper):

```swift
.containerBackground(.fill.tertiary, for: .widget)
```

### Corner Radius

Match iOS standard: 22pt (handled automatically by WidgetKit)

### Typography

Always use SF Pro (system font) in widgets:

```swift
.font(.system(size: 17))           // Body
.font(.system(size: 13))           // Caption
.font(.system(size: 17, weight: .semibold))  // Title
```

### Padding

Use standard iOS widget padding: 16pt

```swift
.padding(16)
// Or use contentMarginsDisabled() for edge-to-edge
```

### Colors

- Text: System label colors (`.primary`, `.secondary`)
- Backgrounds: System fills (`.fill.tertiary`)
- Accents: Only for checkmarks and interactive states

```swift
// Don't use brand colors
Color(hex: "2563EB")  // ❌

// Use system colors
Color.accentColor     // ✓
Color.green           // ✓ for success
```

---

## Update Strategy

### Timeline Configuration

```swift
func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> ()) {
    let currentDate = Date()
    let refreshDate = Calendar.current.date(byAdding: .minute, value: 15, to: currentDate)!

    let entry = SimpleEntry(date: currentDate, ...)
    let timeline = Timeline(entries: [entry], policy: .after(refreshDate))

    completion(timeline)
}
```

### Refresh Triggers

Refresh widget data when:
- App comes to foreground
- Habit is completed
- Pool level changes significantly (±10%)

```swift
// In app code
WidgetCenter.shared.reloadAllTimelines()
```

---

## Deep Linking

Handle widget taps with URL schemes:

```swift
// Widget configuration
.widgetURL(URL(string: "ascent://today"))
.widgetURL(URL(string: "ascent://habits"))
.widgetURL(URL(string: "ascent://task/\(taskId)"))

// In app
.onOpenURL { url in
    if url.scheme == "ascent" {
        switch url.host {
        case "today": navigateToToday()
        case "habits": navigateToHabits()
        case "task": navigateToTask(id: url.lastPathComponent)
        default: break
        }
    }
}
```

---

## Testing Checklist

- [ ] Widget displays correctly at all sizes
- [ ] Text is readable on various wallpapers
- [ ] Interactive elements work (iOS 17+)
- [ ] Deep links navigate correctly
- [ ] Data refreshes appropriately
- [ ] Widget respects Dynamic Type
- [ ] Dark mode appearance is correct
