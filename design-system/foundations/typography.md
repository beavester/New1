# Typography

## Font Stack

### Display / Headlines

```css
font-family: "Instrument Serif", Georgia, serif;
```

**Why:** Serif headlines are uncommon in apps—instant differentiation. Instrument Serif has modern proportions with classic warmth. Signals "thoughtfulness" over "tech startup."

### Body / UI

```css
font-family: "DM Sans", -apple-system, sans-serif;
```

**Why:** Geometric but not cold. Has subtle quirks in the `g` and `a`. More personality than Inter, less quirky than Nunito. Excellent legibility at small sizes.

### Monospace (for numbers, timers, data)

```css
font-family: "JetBrains Mono", SF Mono, Consolas, monospace;
```

**Why:** Clear distinction between `0/O`, `1/l/I`. Numbers in timers and stats need precision.

---

## Type Scale

```css
--text-xs:    12px / 1.5    /* Captions, timestamps */
--text-sm:    14px / 1.5    /* Secondary text, labels */
--text-base:  16px / 1.6    /* Body text */
--text-lg:    18px / 1.5    /* Emphasized body */
--text-xl:    22px / 1.4    /* Section headers */
--text-2xl:   28px / 1.3    /* Screen titles */
--text-3xl:   36px / 1.2    /* Hero headlines */
--text-4xl:   48px / 1.1    /* Landing page hero */
```

---

## Typography Rules

1. **Headlines in Instrument Serif. Body in DM Sans. Never mix.**

2. **Left-align everything.** Centered text is harder to scan and feels "designed" rather than functional.

3. **No bold abuse.** If everything is bold, nothing is. Bold is for scannable anchors only.

4. **Line height decreases as size increases.** Large text needs tighter leading.

---

## Usage Examples

### Screen Title

```jsx
<h1 style={{
  fontFamily: 'Instrument Serif',
  fontSize: 'var(--text-2xl)',
  lineHeight: 1.3
}}>
  Good morning.
</h1>
```

### Body Text

```jsx
<p style={{
  fontFamily: 'DM Sans',
  fontSize: 'var(--text-base)',
  lineHeight: 1.6,
  color: 'var(--text-primary)'
}}>
  The goal isn't perfection. It's showing up.
</p>
```

### Timer / Stats

```jsx
<span style={{
  fontFamily: 'JetBrains Mono',
  fontSize: 'var(--text-xl)'
}}>
  72%
</span>
```

---

## Font Loading

Load fonts early in the splash screen sequence. Instrument Serif and DM Sans are Google Fonts with good CDN support, but **bundle them locally** to avoid FOUT (flash of unstyled text).

```jsx
// In your app entry point
import './fonts/InstrumentSerif.css';
import './fonts/DMSans.css';
import './fonts/JetBrainsMono.css';
```
