# Booksmith — UI Wireframes

ASCII wireframes for all key screens. The app has two sides:
1. **Dashboard** — for organization admins/employees (SPA)
2. **Booking Page** — for customers (public, server-rendered)

---

## Dashboard

### Layout Shell

```
┌──────────────────────────────────────────────────────────────────┐
│  ☰  Booksmith          Acme Wellness ▾           ○ Jane Smith ▾ │
├──────────┬───────────────────────────────────────────────────────┤
│          │                                                       │
│ Calendar │                                                       │
│ Bookings │              [ Main Content Area ]                    │
│ Services │                                                       │
│ Team     │                                                       │
│ Customers│                                                       │
│ Pages    │                                                       │
│ Analytics│                                                       │
│          │                                                       │
│ ──────── │                                                       │
│ Settings │                                                       │
│ API Keys │                                                       │
│          │                                                       │
└──────────┴───────────────────────────────────────────────────────┘
```

### Calendar View (Default Screen)

```
┌──────────────────────────────────────────────────────────────────┐
│  Calendar                                     ◀ Mar 15-21 2026 ▶│
│                                                                  │
│  [Day] [Week] [Month]          Filter: All employees ▾          │
│                                                                  │
│  ┌────────┬────────┬────────┬────────┬────────┬────────┬───────┐│
│  │  Mon   │  Tue   │  Wed   │  Thu   │  Fri   │  Sat   │  Sun  ││
│  │  15    │  16    │  17    │  18    │  19    │  20    │  21   ││
│  ├────────┼────────┼────────┼────────┼────────┼────────┼───────┤│
│  │ 9:00   │        │ 9:00   │        │ 9:00   │ 10:00  │       ││
│  │┌──────┐│        │┌──────┐│        │┌──────┐│┌──────┐│       ││
│  ││Consult││        ││Massage││        ││Consult││Group  ││       ││
│  ││J.Doe  ││        ││S.Park ││        ││M.Lee  ││Yoga   ││       ││
│  │└──────┘│        │└──────┘│        │└──────┘│└──────┘│       ││
│  │        │ 11:00  │        │ 11:00  │        │        │       ││
│  │ 10:30  │┌──────┐│ 10:30  │┌──────┐│ 10:30  │        │       ││
│  │┌──────┐││Consult││┌──────┐││Therapy│││┌──────┐│        │       ││
│  ││Follow ││└──────┘│││Massage│││M.Lee  │││Consult││        │       ││
│  ││-up    ││        ││└──────┘│└──────┘││J.Doe  ││        │       ││
│  │└──────┘│        │        │        │└──────┘│        │       ││
│  │        │        │        │ 14:00  │        │        │       ││
│  │ 14:00  │ 14:00  │        │┌──────┐│ 14:00  │        │       ││
│  │┌──────┐│┌──────┐│        ││Consult││┌──────┐│        │       ││
│  ││Therapy│││New    ││        ││J.Doe  │││Massage││        │       ││
│  ││S.Park │││Client │││        │└──────┘││S.Park ││        │       ││
│  │└──────┘│└──────┘│        │        │└──────┘│        │       ││
│  └────────┴────────┴────────┴────────┴────────┴────────┴───────┘│
│                                                                  │
│                                        [ + New Booking ]         │
└──────────────────────────────────────────────────────────────────┘
```

### Bookings List

```
┌──────────────────────────────────────────────────────────────────┐
│  Bookings                                     [ + New Booking ]  │
│                                                                  │
│  [Upcoming] [Past] [Cancelled]     Search: [_______________] 🔍 │
│                                                                  │
│  Filter: All services ▾  All employees ▾  All statuses ▾        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ● Confirmed   Mar 15, 9:00 AM – 10:00 AM                  │  │
│  │   60-min Consultation · Jane Doe → Dr. Smith               │  │
│  │   jane.doe@email.com · $120.00 paid                        │  │
│  │                                              [⋯]           │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ○ Pending     Mar 15, 10:30 AM – 11:30 AM                 │  │
│  │   Follow-up Session · John Park → Dr. Smith                │  │
│  │   john.park@email.com · $80.00 awaiting payment            │  │
│  │                                              [⋯]           │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ● Confirmed   Mar 15, 2:00 PM – 3:00 PM                   │  │
│  │   Deep Tissue Massage · Sarah Lee → Mike Chen              │  │
│  │   sarah.lee@email.com · $95.00 paid                        │  │
│  │                                              [⋯]           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Showing 1-25 of 142              [ ◀ Previous ]  [ Next ▶ ]    │
└──────────────────────────────────────────────────────────────────┘
```

### Booking Detail (Slide-over Panel)

```
                          ┌────────────────────────────────────┐
                          │  ✕                    Booking Detail│
                          │                                    │
                          │  ● Confirmed                       │
                          │                                    │
                          │  60-min Consultation               │
                          │  March 15, 2026                    │
                          │  9:00 AM – 10:00 AM (EST)          │
                          │                                    │
                          │  ── Customer ──────────────────    │
                          │  Jane Doe                          │
                          │  jane.doe@email.com                │
                          │  +1 (555) 123-4567                 │
                          │                                    │
                          │  ── Assigned To ───────────────    │
                          │  Dr. Smith                         │
                          │                                    │
                          │  ── Payment ───────────────────    │
                          │  $120.00 · Paid via Stripe         │
                          │  pi_3Nk...                         │
                          │                                    │
                          │  ── Customer Notes ────────────    │
                          │  "First time visit, referred by    │
                          │   colleague."                      │
                          │                                    │
                          │  ── Internal Notes ────────────    │
                          │  [Add a note...]                   │
                          │                                    │
                          │  ── Notifications ─────────────    │
                          │  ✓ Confirmation email sent 3/14    │
                          │  ✓ Reminder email sent 3/14        │
                          │  ◻ Reminder SMS scheduled 3/15 8AM │
                          │                                    │
                          │  ┌──────────┐ ┌──────────────────┐│
                          │  │ Reschedule│ │ Cancel Booking   ││
                          │  └──────────┘ └──────────────────┘│
                          │  ┌────────────────────────────────┐│
                          │  │      Mark as Completed         ││
                          │  └────────────────────────────────┘│
                          └────────────────────────────────────┘
```

### Services Management

```
┌──────────────────────────────────────────────────────────────────┐
│  Services                                     [ + New Service ]  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ■ 60-min Consultation                                      │  │
│  │   60 min · $120.00 · 3 employees                           │  │
│  │   15 bookings this month                       [Edit] [⋯]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ■ 30-min Follow-up                                         │  │
│  │   30 min · $80.00 · 2 employees                            │  │
│  │   8 bookings this month                        [Edit] [⋯]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ■ Deep Tissue Massage                                      │  │
│  │   90 min · $150.00 · 1 employee                            │  │
│  │   22 bookings this month                       [Edit] [⋯]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ■ Group Yoga Class                              👥 12 max  │  │
│  │   60 min · $25.00/person · 1 employee                      │  │
│  │   45 participants this month                   [Edit] [⋯]  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Inactive Services                                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ░ Introductory Session (paused)                [Activate]  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Service Editor

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back to Services                                              │
│                                                                  │
│  Edit Service                                                    │
│                                                                  │
│  Name            [60-min Consultation____________]               │
│  Description     [Initial consultation session    ]              │
│                  [for new and returning clients.  ]              │
│  Duration        [60] minutes                                    │
│  Price           $ [120] .00                                     │
│  Deposit         $ [__] .00 (optional)                           │
│  Color           [■ Blue ▾]                                      │
│                                                                  │
│  ── Buffers ─────────────────────────────────────────            │
│  Before          [15] min  (prep time)                           │
│  After           [10] min  (cleanup)                             │
│                                                                  │
│  ── Group Booking ───────────────────────────────────            │
│  [ ] This is a group/class service                               │
│                                                                  │
│  ── Assigned Employees ──────────────────────────────            │
│  [✓] Dr. Smith               $120.00 (default)                  │
│  [✓] Dr. Johnson             $120.00 (default)                  │
│  [✓] Dr. Williams            $140.00 (custom)     [edit]        │
│  [ ] Mike Chen                                                   │
│                                                                  │
│  ── Intake Form (Optional) ──────────────────────────            │
│  [ + Add custom field ]                                          │
│  1. "Reason for visit" — Text (required)                         │
│  2. "Insurance provider" — Dropdown (optional)                   │
│                                                                  │
│                              [ Cancel ]  [ Save Changes ]        │
└──────────────────────────────────────────────────────────────────┘
```

### Team / Employees

```
┌──────────────────────────────────────────────────────────────────┐
│  Team                                        [ + Invite Member ] │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ○ Dr. Smith              Admin                             │  │
│  │   dr.smith@acme.com      4 services · 32 bookings/mo      │  │
│  │                                                            │  │
│  │   Mon-Fri: 9:00 AM – 5:00 PM                              │  │
│  │   Sat: 10:00 AM – 2:00 PM                   [Edit] [⋯]   │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ○ Mike Chen              Staff                             │  │
│  │   mike@acme.com          2 services · 28 bookings/mo      │  │
│  │                                                            │  │
│  │   Mon-Sat: 8:00 AM – 6:00 PM                [Edit] [⋯]   │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ ○ Sarah Park             Staff                             │  │
│  │   sarah@acme.com         3 services · 18 bookings/mo      │  │
│  │                                                            │  │
│  │   Tue-Sat: 10:00 AM – 7:00 PM               [Edit] [⋯]   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Employee Availability Editor

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Dr. Smith                                                     │
│                                                                  │
│  Availability                                                    │
│                                                                  │
│  [Weekly Schedule]  [Date Overrides]                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Monday      [✓]   09:00 ▾  —  17:00 ▾   [ + Add block ] │   │
│  │ Tuesday     [✓]   09:00 ▾  —  17:00 ▾   [ + Add block ] │   │
│  │ Wednesday   [✓]   09:00 ▾  —  17:00 ▾   [ + Add block ] │   │
│  │ Thursday    [✓]   09:00 ▾  —  17:00 ▾   [ + Add block ] │   │
│  │ Friday      [✓]   09:00 ▾  —  17:00 ▾   [ + Add block ] │   │
│  │ Saturday    [✓]   10:00 ▾  —  14:00 ▾   [ + Add block ] │   │
│  │ Sunday      [ ]   — Not available —                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ── Date Overrides ──────────────────────────────────            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Mar 17 (Wed)   Blocked — "Dentist appointment"    [✕]    │   │
│  │ Mar 25 (Thu)   10:00 – 14:00 — "Half day"         [✕]    │   │
│  │ Apr 01 (Thu)   Blocked — "Holiday"                 [✕]    │   │
│  └──────────────────────────────────────────────────────────┘   │
│  [ + Add Date Override ]                                         │
│                                                                  │
│                                              [ Save Changes ]    │
└──────────────────────────────────────────────────────────────────┘
```

### Analytics Dashboard

```
┌──────────────────────────────────────────────────────────────────┐
│  Analytics                               March 2026  [▾ Custom] │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ Bookings │ │ Revenue  │ │ No-shows │ │ New      │           │
│  │   142    │ │ $14,280  │ │   4.2%   │ │Customers │           │
│  │ +12% ▲   │ │ +8% ▲    │ │ -1.1% ▼  │ │   23     │           │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
│                                                                  │
│  ── Booking Volume ──────────────────────────────────            │
│  │                                          ╭─╮                  │
│  │                               ╭─╮      │  │                  │
│  │                    ╭─╮       │  │ ╭─╮  │  │                  │
│  │         ╭─╮ ╭─╮  │  │ ╭─╮  │  │ │  │  │  │                  │
│  │    ╭─╮ │  │ │  │  │  │ │  │  │  │ │  │  │  │                  │
│  │   │  │ │  │ │  │  │  │ │  │  │  │ │  │  │  │                  │
│  └───┴──┴─┴──┴─┴──┴──┴──┴─┴──┴──┴──┴─┴──┴──┴──┴──              │
│    W1     W2     W3     W4    W1     W2     W3    W4             │
│    ──── February ────   ────── March ──────                      │
│                                                                  │
│  ── Popular Services ────── ── Busiest Times ──────────          │
│  │                        │ │     M  T  W  T  F  S    │          │
│  │ Consultation    45%  ██│ │ 9a  ·  ·  ·  ·  ·  ·   │          │
│  │ Massage         28%  █ │ │10a  ·  ■  ·  ■  ·  ·   │          │
│  │ Follow-up       15%  █ │ │11a  ■  ■  ■  ■  ·  ·   │          │
│  │ Group Yoga      12%  █ │ │12p  ·  ·  ·  ·  ·  ·   │          │
│  │                        │ │ 1p  ·  ·  ·  ·  ·  ·   │          │
│  │                        │ │ 2p  ■  ■  ■  ■  ■  ·   │          │
│  │                        │ │ 3p  ■  ·  ■  ·  ■  ·   │          │
│  │                        │ │ 4p  ·  ·  ·  ·  ·  ·   │          │
│  └────────────────────────┘ └─────────────────────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

### Customer Directory

```
┌──────────────────────────────────────────────────────────────────┐
│  Customers (387)                             [ + Add Customer ]  │
│                                                                  │
│  Search: [_______________] 🔍     Tags: [All ▾]                 │
│                                                                  │
│  ┌────────┬──────────────────┬──────────┬────────┬────────────┐ │
│  │ Name   │ Email            │ Bookings │ Spent  │ Last Visit │ │
│  ├────────┼──────────────────┼──────────┼────────┼────────────┤ │
│  │ J.Doe  │ jane@email.com   │    12    │ $1,440 │ Mar 15     │ │
│  │ J.Park │ john@email.com   │     8    │   $640 │ Mar 12     │ │
│  │ S.Lee  │ sarah@email.com  │    22    │ $3,300 │ Mar 14     │ │
│  │ M.Wang │ mei@email.com    │     3    │   $360 │ Feb 28     │ │
│  │ ...    │ ...              │   ...    │   ...  │ ...        │ │
│  └────────┴──────────────────┴──────────┴────────┴────────────┘ │
│                                                                  │
│  [ Export CSV ]                      [ ◀ 1 2 3 ... 16 ▶ ]       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Public Booking Page (Customer-Facing)

### Service Selection

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│              ○  Acme Wellness Center                             │
│              Book an appointment                                 │
│                                                                  │
│  ── Select a Service ────────────────────────────────            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  60-min Consultation                                       │  │
│  │  Initial or returning visit with one of our specialists.   │  │
│  │  60 min · $120.00                              [ Select ]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  30-min Follow-up                                          │  │
│  │  Quick check-in on your progress.                          │  │
│  │  30 min · $80.00                               [ Select ]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Deep Tissue Massage                                       │  │
│  │  Therapeutic deep tissue work for tension relief.          │  │
│  │  90 min · $150.00                              [ Select ]  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Group Yoga Class                                          │  │
│  │  All-levels guided yoga. Max 12 participants.              │  │
│  │  60 min · $25.00                               [ Select ]  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│                              Powered by Booksmith                │
└──────────────────────────────────────────────────────────────────┘
```

### Employee Selection (Optional)

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ← 60-min Consultation                                           │
│                                                                  │
│  ── Choose a Provider (optional) ────────────────────            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ○ Dr. Smith                                               │  │
│  │    Specializes in holistic wellness                         │  │
│  │    Next available: Tomorrow, 9:00 AM          [ Select ]   │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  ○ Dr. Johnson                                             │  │
│  │    Sports medicine and rehabilitation                       │  │
│  │    Next available: Thursday, 2:00 PM          [ Select ]   │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  ○ No preference — show me the first available             │  │
│  │                                               [ Select ]   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Date & Time Selection

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ← Dr. Smith · 60-min Consultation                               │
│                                                                  │
│  ── Pick a Date & Time ──────────────────────────────            │
│                                                                  │
│  Timezone: America/New_York (EDT) [change]                       │
│                                                                  │
│       ◀  March 2026  ▶                                           │
│  Mo  Tu  We  Th  Fr  Sa  Su                                     │
│                           1                                      │
│   2   3   4   5   6   7   8                                     │
│   9  10  11  12  13  14  15                                     │
│  16 [17] 18  19  20  21  22       Available times for Mar 17:   │
│  23  24  25  26  27  28  29                                     │
│  30  31                            ┌──────────────────────┐     │
│                                    │  ○  9:00 AM          │     │
│  ■ = available                     │  ○ 10:30 AM          │     │
│  □ = unavailable                   │  ○  2:00 PM          │     │
│                                    │  ○  3:30 PM          │     │
│                                    └──────────────────────┘     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Booking Confirmation Form

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ← Change time                                                   │
│                                                                  │
│  ── Confirm Your Booking ────────────────────────────            │
│                                                                  │
│  ┌────────────────────────────────────────────────┐              │
│  │  60-min Consultation with Dr. Smith             │              │
│  │  Wednesday, March 17, 2026                      │              │
│  │  9:00 AM – 10:00 AM (EDT)                       │              │
│  │  $120.00                                        │              │
│  └────────────────────────────────────────────────┘              │
│                                                                  │
│  Your Details                                                    │
│                                                                  │
│  Name *          [________________________]                      │
│  Email *         [________________________]                      │
│  Phone           [________________________]                      │
│                                                                  │
│  Reason for visit *                                              │
│  [____________________________________________]                  │
│  [____________________________________________]                  │
│                                                                  │
│  Notes (optional)                                                │
│  [____________________________________________]                  │
│                                                                  │
│  [ ] I agree to the cancellation policy                          │
│                                                                  │
│  ┌────────────────────────────────────────────────┐              │
│  │         Pay $120.00 & Confirm Booking          │              │
│  └────────────────────────────────────────────────┘              │
│                                                                  │
│  Cancellation policy: Free cancellation up to 24 hours           │
│  before the appointment. Late cancellations may be charged.      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Booking Success

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                          ✓                                       │
│                                                                  │
│              Booking Confirmed!                                  │
│                                                                  │
│   60-min Consultation with Dr. Smith                             │
│   Wednesday, March 17, 2026                                      │
│   9:00 AM – 10:00 AM (EDT)                                      │
│                                                                  │
│   A confirmation email has been sent to                          │
│   jane.doe@email.com                                             │
│                                                                  │
│   ┌──────────────────┐  ┌──────────────────┐                    │
│   │ Add to Calendar  │  │ Book Another     │                    │
│   └──────────────────┘  └──────────────────┘                    │
│                                                                  │
│   Need to cancel or reschedule?                                  │
│   Use the link in your confirmation email.                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Embeddable Widget (Inline)

```
┌─── On customer's own website ────────────────────────────────────┐
│                                                                  │
│  [... website content above ...]                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Book an Appointment                                      │   │
│  │                                                           │   │
│  │  Service:  [60-min Consultation ▾]                        │   │
│  │  With:     [Any available ▾      ]                        │   │
│  │  Date:     [March 17, 2026 ▾     ]                        │   │
│  │                                                           │   │
│  │  Available times:                                         │   │
│  │  [9:00 AM] [10:30 AM] [2:00 PM] [3:30 PM]               │   │
│  │                                                           │   │
│  │  [ Continue → ]                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  [... website content below ...]                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```
