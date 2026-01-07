# Navigation (Bottom Tab Bar)

The primary navigation component for the app.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│                                                 │
│    Today       Habits      Coach       You      │
│      ●           ○           ○          ○       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Specifications

| Property        | Value                                |
|-----------------|--------------------------------------|
| Height          | 80px (including safe area)           |
| Background      | `--bg-primary`                       |
| Top border      | 1px solid `--bg-tertiary`            |
| Icon size       | 24px                                 |
| Icon stroke     | 1.5px                                |
| Label font      | DM Sans, `--text-xs`                 |

---

## Tab Items

| Tab     | Icon (outline)    | Screen         |
|---------|-------------------|----------------|
| Today   | Calendar/sun      | Home screen    |
| Habits  | List/checkmarks   | Habit tracker  |
| Coach   | Chat bubble       | AI coach       |
| You     | Person outline    | Profile/settings |

---

## Visual Treatment

### Background

```css
.tab-bar {
  background: var(--bg-primary);
  border-top: 1px solid var(--bg-tertiary);
  height: 80px;
  padding-bottom: env(safe-area-inset-bottom);
}
```

### Icons

- Style: Stroke/outline (not filled)
- Weight: 1.5px stroke
- Color (inactive): `--text-secondary`
- Color (active): `--text-primary`

### Active State

- Icon becomes filled (not just color change)
- Dot indicator appears below (4px circle)
- No highlight background

```css
.tab-item.active .tab-icon {
  /* Icon fill variant */
}

.tab-item.active::after {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-primary);
  margin-top: var(--space-1);
}
```

### Labels

- Always visible (not icons-only)
- Font: DM Sans, `--text-xs`
- Color matches icon state

---

## Why This Approach

- **No blurred glass effect** — distracting
- **No floating tab bar** — breaks expectations
- **Labels always visible** — accessibility, ADHD users need clarity
- **Simple active state** — dot indicator is subtle but clear

---

## Animation

### Tab Switch

Minimal animation on tab change:

```jsx
const tabAnimation = {
  initial: { opacity: 0.7 },
  animate: { opacity: 1 },
  transition: { duration: 0.15 }
};
```

### No spring or bounce on tab change.

---

## Implementation

```jsx
function TabBar({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'today', label: 'Today', icon: CalendarIcon },
    { id: 'habits', label: 'Habits', icon: ListIcon },
    { id: 'coach', label: 'Coach', icon: ChatIcon },
    { id: 'you', label: 'You', icon: PersonIcon },
  ];

  return (
    <nav className="tab-bar">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`tab-item ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          <tab.icon
            size={24}
            strokeWidth={1.5}
            filled={activeTab === tab.id}
          />
          <span className="tab-label">{tab.label}</span>
          {activeTab === tab.id && <span className="active-dot" />}
        </button>
      ))}
    </nav>
  );
}
```

```css
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  align-items: center;
  height: 80px;
  background: var(--bg-primary);
  border-top: 1px solid var(--bg-tertiary);
  padding-bottom: env(safe-area-inset-bottom);
}

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  background: none;
  border: none;
  cursor: pointer;
  min-width: 64px;
}

.tab-item .tab-icon {
  color: var(--text-secondary);
}

.tab-item.active .tab-icon {
  color: var(--text-primary);
}

.tab-label {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.tab-item.active .tab-label {
  color: var(--text-primary);
}

.active-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-primary);
}
```

---

## Safe Area Handling

```css
.tab-bar {
  padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
}

/* Content area needs matching bottom padding */
.main-content {
  padding-bottom: calc(80px + env(safe-area-inset-bottom));
}
```

---

## Haptic Feedback

On tab tap (iOS):

```jsx
import * as Haptics from 'expo-haptics';

const handleTabPress = (tabId) => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  onTabChange(tabId);
};
```
