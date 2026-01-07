# Implementation Notes

## Tech Stack Recommendations

### Core Framework

**React Native + Expo** for cross-platform development

```bash
npx create-expo-app ascent --template blank-typescript
```

### Animation

**Reanimated 3** for performant, native-driven animations

```bash
npx expo install react-native-reanimated
```

Features:
- Spring physics with native driver
- Gesture-driven animations
- 60fps performance
- Worklet-based (runs on UI thread)

### Haptics

**Expo Haptics** for tactile feedback

```bash
npx expo install expo-haptics
```

```jsx
import * as Haptics from 'expo-haptics';

// Button press
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

// Success
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
```

### Custom Graphics

**React Native Skia** for advanced pool visualization (if needed)

```bash
npx expo install @shopify/react-native-skia
```

Use for:
- Custom liquid animations
- Gradient fills
- Complex shape rendering

For simpler pool: CSS/Reanimated is sufficient.

### Widgets (iOS)

**Native Swift + WidgetKit** (can't use React Native)

Widgets must be written in native code:
- Create a Widget Extension target in Xcode
- Share data via App Groups
- Use SwiftUI for widget UI

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Cold start | < 2 seconds |
| Screen transition | < 300ms |
| Touch feedback | < 100ms |
| Pool animation | 60fps |
| Memory usage | < 150MB |

### Optimization Strategies

#### 1. Use Native Driver

```jsx
// ✓ Runs on UI thread
useAnimatedStyle(() => ({
  transform: [{ translateY: offset.value }]
}));

// ✗ Runs on JS thread
useAnimatedStyle(() => ({
  height: height.value  // Layout props can't use native driver
}));
```

#### 2. Memoize Components

```jsx
const HabitCard = memo(({ habit, onComplete }) => {
  // Component implementation
}, (prevProps, nextProps) => {
  return prevProps.habit.id === nextProps.habit.id &&
         prevProps.habit.completedToday === nextProps.habit.completedToday;
});
```

#### 3. Virtualize Lists

```jsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={habits}
  renderItem={({ item }) => <HabitCard habit={item} />}
  estimatedItemSize={72}
/>
```

#### 4. Preload Fonts

```jsx
// App.tsx
import { useFonts } from 'expo-font';

const [fontsLoaded] = useFonts({
  'InstrumentSerif-Regular': require('./assets/fonts/InstrumentSerif-Regular.ttf'),
  'DMSans-Regular': require('./assets/fonts/DMSans-Regular.ttf'),
  'DMSans-SemiBold': require('./assets/fonts/DMSans-SemiBold.ttf'),
  'JetBrainsMono-Regular': require('./assets/fonts/JetBrainsMono-Regular.ttf'),
});

if (!fontsLoaded) {
  return <SplashScreen />;
}
```

---

## Font Loading

### Download Fonts

All fonts from Google Fonts:
- [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif)
- [DM Sans](https://fonts.google.com/specimen/DM+Sans)
- [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono)

### Bundle Locally

**Always bundle fonts locally** to avoid:
- FOUT (Flash of Unstyled Text)
- Network dependency
- Loading delays

```
assets/
└── fonts/
    ├── InstrumentSerif-Regular.ttf
    ├── InstrumentSerif-Italic.ttf
    ├── DMSans-Regular.ttf
    ├── DMSans-Medium.ttf
    ├── DMSans-SemiBold.ttf
    ├── DMSans-Bold.ttf
    └── JetBrainsMono-Regular.ttf
```

### Font Configuration

```jsx
// theme/fonts.ts
export const fonts = {
  display: {
    regular: 'InstrumentSerif-Regular',
    italic: 'InstrumentSerif-Italic',
  },
  body: {
    regular: 'DMSans-Regular',
    medium: 'DMSans-Medium',
    semiBold: 'DMSans-SemiBold',
    bold: 'DMSans-Bold',
  },
  mono: {
    regular: 'JetBrainsMono-Regular',
  },
};
```

---

## Project Structure

```
src/
├── app/                    # Expo Router screens
│   ├── (tabs)/
│   │   ├── index.tsx       # Home/Today
│   │   ├── habits.tsx
│   │   ├── coach.tsx
│   │   └── profile.tsx
│   ├── onboarding/
│   │   ├── drains.tsx
│   │   ├── friction.tsx
│   │   └── ...
│   └── _layout.tsx
├── components/
│   ├── ui/                 # Design system components
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Text.tsx
│   │   └── ...
│   ├── DopaminePool/
│   │   ├── Pool.tsx
│   │   ├── PoolCompact.tsx
│   │   └── usePoolAnimation.ts
│   ├── HabitCard/
│   │   ├── HabitCard.tsx
│   │   ├── WeekDots.tsx
│   │   └── ...
│   └── ...
├── theme/
│   ├── colors.ts
│   ├── fonts.ts
│   ├── spacing.ts
│   └── index.ts
├── hooks/
│   ├── useTheme.ts
│   ├── useReducedMotion.ts
│   └── ...
├── stores/                 # State management
│   ├── habitStore.ts
│   ├── poolStore.ts
│   └── ...
└── utils/
    ├── animations.ts
    ├── haptics.ts
    └── ...
```

---

## State Management

### Zustand (Recommended)

Simple, performant, TypeScript-friendly:

```bash
npm install zustand
```

```tsx
// stores/habitStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface HabitStore {
  habits: Habit[];
  addHabit: (habit: Habit) => void;
  toggleComplete: (id: string, date: string) => void;
}

export const useHabitStore = create<HabitStore>()(
  persist(
    (set) => ({
      habits: [],
      addHabit: (habit) =>
        set((state) => ({ habits: [...state.habits, habit] })),
      toggleComplete: (id, date) =>
        set((state) => ({
          habits: state.habits.map((h) =>
            h.id === id
              ? { ...h, completions: toggleDate(h.completions, date) }
              : h
          ),
        })),
    }),
    { name: 'habit-storage' }
  )
);
```

---

## Navigation

### Expo Router (Recommended)

File-based routing, similar to Next.js:

```bash
npx expo install expo-router
```

```
app/
├── (tabs)/
│   ├── _layout.tsx      # Tab bar configuration
│   ├── index.tsx        # /
│   ├── habits.tsx       # /habits
│   ├── coach.tsx        # /coach
│   └── profile.tsx      # /profile
├── onboarding/
│   └── [step].tsx       # /onboarding/1, /onboarding/2, etc.
└── _layout.tsx          # Root layout
```

### Tab Bar Configuration

```tsx
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          height: 80,
          backgroundColor: colors.bgPrimary,
          borderTopColor: colors.bgTertiary,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.textPrimary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarLabelStyle: {
          fontFamily: fonts.body.regular,
          fontSize: 12,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ color }) => <CalendarIcon color={color} />,
        }}
      />
      {/* ... other tabs */}
    </Tabs>
  );
}
```

---

## Testing

### Unit Tests

```bash
npm install --save-dev jest @testing-library/react-native
```

```tsx
// __tests__/HabitCard.test.tsx
import { render, fireEvent } from '@testing-library/react-native';
import { HabitCard } from '../components/HabitCard';

test('displays habit name and streak', () => {
  const habit = { name: 'Morning Walk', streak: 12 };
  const { getByText } = render(<HabitCard habit={habit} />);

  expect(getByText('Morning Walk')).toBeTruthy();
  expect(getByText('12 days')).toBeTruthy();
});
```

### E2E Tests

```bash
npm install --save-dev detox
```

```tsx
// e2e/onboarding.test.ts
describe('Onboarding', () => {
  it('should complete drain selection', async () => {
    await element(by.text('TikTok')).tap();
    await element(by.text('Instagram')).tap();
    await expect(element(by.text('Select 1-3 to continue'))).toBeVisible();
  });
});
```

---

## Deployment

### iOS

1. Create App Store Connect record
2. Configure `app.json`:

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.yourcompany.ascent",
      "buildNumber": "1",
      "supportsTablet": true
    }
  }
}
```

3. Build and submit:

```bash
eas build --platform ios
eas submit --platform ios
```

### Android

1. Create Google Play Console record
2. Configure `app.json`:

```json
{
  "expo": {
    "android": {
      "package": "com.yourcompany.ascent",
      "versionCode": 1
    }
  }
}
```

3. Build and submit:

```bash
eas build --platform android
eas submit --platform android
```

---

## Monitoring

### Error Tracking

```bash
npx expo install sentry-expo
```

### Analytics (Privacy-Respecting)

Consider privacy-first options:
- Plausible
- Simple Analytics
- Self-hosted PostHog

Avoid:
- Google Analytics
- Facebook SDK
- Any SDK that sells user data
