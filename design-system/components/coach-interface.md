# AI Coach Interface

A full-screen modal for interacting with the AI coach.

## Visual Structure

```
┌─────────────────────────────────────────────────┐
│  Coach                                     ✕    │
├─────────────────────────────────────────────────┤
│                                                 │
│           ┌──────────────────────────┐          │
│           │ What's blocking you?     │          │
│           └──────────────────────────┘          │
│                                                 │
│    ┌──────────────┐  ┌──────────────────────┐   │
│    │ No time      │  │ Don't feel like it   │   │
│    └──────────────┘  └──────────────────────┘   │
│    ┌──────────────┐  ┌──────────────────────┐   │
│    │ Too hard     │  │ Something else       │   │
│    └──────────────┘  └──────────────────────┘   │
│                                                 │
├─────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │ Type a message...                       │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

---

## Layout

- Opens as **full-screen modal** (not bottom sheet)
- Header with title and close button
- Scrollable message area
- Fixed input at bottom

---

## Visual Treatment

### Header

```css
.coach-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-4);
  border-bottom: 1px solid var(--bg-tertiary);
}

.coach-title {
  font-family: 'DM Sans';
  font-size: var(--text-lg);
  font-weight: 600;
}

.close-button {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-secondary);
}
```

### Suggestion Chips

```css
.suggestion-chip {
  padding: var(--space-3) var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  font-family: 'DM Sans';
  font-size: var(--text-sm);
  color: var(--text-primary);
  cursor: pointer;
}

.suggestion-chip:hover {
  background: var(--bg-tertiary);
}
```

### Messages

- **User messages:** Right-aligned, `--bg-tertiary` background
- **AI messages:** Left-aligned, no background (just text)
- No avatars, no colored bubbles

```css
.message {
  max-width: 85%;
  padding: var(--space-3) var(--space-4);
  border-radius: 12px;
  margin-bottom: var(--space-3);
}

.message.user {
  align-self: flex-end;
  background: var(--bg-tertiary);
}

.message.ai {
  align-self: flex-start;
  background: transparent;
  padding-left: 0;
}
```

### Input Area

```css
.input-area {
  padding: var(--space-4);
  border-top: 1px solid var(--bg-tertiary);
  background: var(--bg-primary);
}

.message-input {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 20px;
  font-family: 'DM Sans';
  font-size: var(--text-base);
}

.message-input::placeholder {
  color: var(--text-tertiary);
}
```

---

## Typing Indicator

Three dots with gentle pulse animation (not bouncing):

```css
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: var(--space-2);
}

.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  animation: pulse 1.5s ease-in-out infinite;
}

.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
```

---

## Anti-patterns

- NO gradient avatar
- NO "AI is thinking" elaborate animation
- NO chat bubbles with tails
- NO purple/teal AI branding
- NO bouncing loading dots
- NO animated emoji reactions

---

## Modal Animation

```jsx
const modalAnimation = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.2, ease: 'easeOut' }
};
```

---

## Implementation

```jsx
function CoachInterface({ isOpen, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const suggestions = [
    'No time',
    "Don't feel like it",
    'Too hard',
    'Something else'
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="coach-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="coach-content"
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.95 }}
          >
            {/* Header */}
            <header className="coach-header">
              <h2 className="coach-title">Coach</h2>
              <button className="close-button" onClick={onClose}>
                <XIcon size={20} />
              </button>
            </header>

            {/* Messages */}
            <div className="messages-area">
              {messages.length === 0 && (
                <div className="initial-prompt">
                  <p className="prompt-text">What's blocking you?</p>
                  <div className="suggestions">
                    {suggestions.map(suggestion => (
                      <button
                        key={suggestion}
                        className="suggestion-chip"
                        onClick={() => handleSuggestion(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  {msg.content}
                </div>
              ))}

              {isTyping && (
                <div className="typing-indicator">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              )}
            </div>

            {/* Input */}
            <div className="input-area">
              <input
                type="text"
                className="message-input"
                placeholder="Type a message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

```css
.coach-modal {
  position: fixed;
  inset: 0;
  background: var(--bg-primary);
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.coach-content {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
}

.initial-prompt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-7) 0;
}

.prompt-text {
  font-family: 'Instrument Serif';
  font-size: var(--text-xl);
  color: var(--text-primary);
}

.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
  max-width: 320px;
}
```
