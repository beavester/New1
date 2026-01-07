# Settings / Profile Screen

Standard settings layout with grouped rows and section headers.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  Settings                                       │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│  NOTIFICATIONS                                  │
│                                                 │
│  Daily reminder                     9:00 AM  >  │
│  Streak protection                       ON  >  │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
│  ACCOUNT                                        │
│                                                 │
│  Subscription                        Free    >  │
│  Export data                                 >  │
│                                                 │
│  ─────────────────────────────────────────────  │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Visual Treatment

### Screen Title

```css
.settings-title {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
  padding: var(--space-5);
}
```

### Section Headers

```css
.section-header {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  padding: var(--space-4) var(--space-5);
  padding-bottom: var(--space-2);
}
```

### Row Items

```css
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 56px;
  padding: 0 var(--space-5);
  background: var(--bg-primary);
  cursor: pointer;
}

.settings-row:active {
  background: var(--bg-secondary);
}
```

### Row Label

```css
.row-label {
  font-family: 'DM Sans';
  font-size: var(--text-base);
  color: var(--text-primary);
}
```

### Row Value

```css
.row-value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-base);
}
```

### Chevron

```css
.chevron {
  color: var(--text-tertiary);
  width: 16px;
  height: 16px;
}
```

### Dividers

```css
.divider {
  height: 1px;
  background: var(--bg-tertiary);
  margin: 0;
}

/* Full-bleed dividers between sections */
.section-divider {
  height: 8px;
  background: var(--bg-secondary);
  margin: var(--space-3) 0;
}
```

### Toggles

Use standard iOS/Android native toggles. Don't reinvent them.

```jsx
// React Native
import { Switch } from 'react-native';

<Switch
  value={isEnabled}
  onValueChange={setIsEnabled}
  trackColor={{
    false: 'var(--bg-tertiary)',
    true: 'var(--accent-action)'
  }}
/>
```

---

## Row Types

### Navigation Row

Navigates to another screen.

```
Daily reminder                     9:00 AM  >
```

### Toggle Row

In-place toggle control.

```
Streak protection                   [====O]
```

### Value Row

Shows current value, tappable to change.

```
Subscription                        Free    >
```

### Action Row

Triggers an action (like export).

```
Export data                                 >
```

### Destructive Row

Dangerous actions (red text).

```css
.destructive .row-label {
  color: var(--accent-danger);
}
```

```
Delete account                              >
```

---

## Implementation

```jsx
function SettingsScreen() {
  const [notifications, setNotifications] = useState(true);
  const [streakProtection, setStreakProtection] = useState(true);

  return (
    <div className="settings-screen">
      <h1 className="settings-title">Settings</h1>

      {/* Notifications Section */}
      <div className="section">
        <h2 className="section-header">Notifications</h2>

        <button className="settings-row" onClick={openReminderPicker}>
          <span className="row-label">Daily reminder</span>
          <span className="row-value">
            9:00 AM
            <ChevronRight className="chevron" />
          </span>
        </button>

        <div className="divider" />

        <div className="settings-row">
          <span className="row-label">Streak protection</span>
          <Switch
            value={streakProtection}
            onValueChange={setStreakProtection}
          />
        </div>
      </div>

      <div className="section-divider" />

      {/* Account Section */}
      <div className="section">
        <h2 className="section-header">Account</h2>

        <button className="settings-row" onClick={openSubscription}>
          <span className="row-label">Subscription</span>
          <span className="row-value">
            Free
            <ChevronRight className="chevron" />
          </span>
        </button>

        <div className="divider" />

        <button className="settings-row" onClick={exportData}>
          <span className="row-label">Export data</span>
          <span className="row-value">
            <ChevronRight className="chevron" />
          </span>
        </button>
      </div>

      <div className="section-divider" />

      {/* Danger Zone */}
      <div className="section">
        <button className="settings-row destructive" onClick={deleteAccount}>
          <span className="row-label">Delete account</span>
          <span className="row-value">
            <ChevronRight className="chevron" />
          </span>
        </button>
      </div>
    </div>
  );
}
```

```css
.settings-screen {
  background: var(--bg-primary);
  min-height: 100vh;
}

.settings-title {
  font-family: 'Instrument Serif';
  font-size: var(--text-2xl);
  color: var(--text-primary);
  padding: var(--space-5);
  padding-top: var(--space-7);
}

.section {
  background: var(--bg-primary);
}

.section-header {
  font-family: 'DM Sans';
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  padding: var(--space-4) var(--space-5);
  padding-bottom: var(--space-2);
}

.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  min-height: 56px;
  padding: 0 var(--space-5);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}

.settings-row:active {
  background: var(--bg-secondary);
}

.row-label {
  font-family: 'DM Sans';
  font-size: var(--text-base);
  color: var(--text-primary);
}

.destructive .row-label {
  color: var(--accent-danger);
}

.row-value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.chevron {
  color: var(--text-tertiary);
}

.divider {
  height: 1px;
  background: var(--bg-tertiary);
  margin-left: var(--space-5);
}

.section-divider {
  height: 8px;
  background: var(--bg-secondary);
}
```
