# Color System

## Primary Palette

### Backgrounds

```css
--bg-primary:     #FAFAF8      /* Warm off-white (not pure white) */
--bg-secondary:   #F5F5F3      /* Subtle warmth for cards */
--bg-tertiary:    #EDEDE9      /* Grouping, sections */
--bg-inverse:     #1C1C1A      /* Dark mode primary */
```

### Text

```css
--text-primary:   #1C1C1A      /* Near-black, not pure #000 */
--text-secondary: #6B6B63      /* Muted but readable */
--text-tertiary:  #9C9C94      /* Hints, timestamps */
--text-inverse:   #FAFAF8      /* On dark backgrounds */
```

### Accent (Reserved for Meaning)

```css
--accent-action:  #2563EB      /* Primary CTA only (blue, not purple) */
--accent-success: #16A34A      /* Completion, earned states */
--accent-warning: #D97706      /* Attention, mid-resistance */
--accent-danger:  #DC2626      /* Hard resistance, breaks */
--accent-earned:  #B45309      /* Amber for "earned" states only */
```

### Pool Visualization

```css
--pool-full:      #60A5FA      /* Luminous sky blue */
--pool-mid:       #3B82F6      /* Standard blue */
--pool-low:       #1D4ED8      /* Deeper blue */
--pool-depleted:  #1E3A5F      /* Near-gray blue */
--pool-glow:      rgba(96, 165, 250, 0.15)  /* Subtle ambient */
```

---

## Design Rules for Color

1. **Accent colors are semantic.** Blue means "action available." Green means "done." Amber means "earned/celebratory." Red means "attention required."

2. **No decorative color.** If a color doesn't communicate state, it shouldn't exist.

3. **Warm neutrals > cool grays.** The slight yellow undertone in our grays prevents the "cold tech" feeling.

4. **Dark mode is true dark mode.** Not gray-mode. `#1C1C1A` as base, not `#121212` (too purple) or `#1A1A1A` (too neutral).

---

## Usage Examples

### Correct Usage

```jsx
// Action button - uses semantic blue
<Button color="--accent-action">Mark Complete</Button>

// Success state - uses semantic green
<Badge color="--accent-success">Done</Badge>

// Card background - uses warm secondary
<Card bg="--bg-secondary">...</Card>
```

### Incorrect Usage

```jsx
// DON'T: Using accent color for decoration
<Divider color="--accent-action" />  // ❌

// DON'T: Creating new colors for "variety"
<Card bg="#E8F4FD">...</Card>  // ❌

// DON'T: Using color to differentiate non-semantic items
<Tag color="purple">Habit 1</Tag>  // ❌
<Tag color="teal">Habit 2</Tag>    // ❌
```
