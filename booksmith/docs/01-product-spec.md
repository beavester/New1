# Booksmith — Product Specification

## Pricing

### Free
- 1 employee
- 1 service type
- 100 bookings/month
- Email notifications (50/mo)
- Basic booking page (booksmith.app/your-name)
- Google Calendar sync
- API access (1,000 calls/day)

### Starter — $19/mo (annual) · $29/mo (monthly)
- 3 employees
- Unlimited service types
- 500 bookings/month
- Email + SMS notifications (200 email, 50 SMS)
- Custom booking page subdomain
- Stripe payments
- Google Calendar + Outlook sync
- Zoom / Google Meet auto-links
- API access (10,000 calls/day)

### Pro — $49/mo (annual) · $69/mo (monthly)
- 15 employees (+$2/employee beyond)
- Unlimited bookings
- 1,000 email + 200 SMS notifications
- White-label (remove branding, custom domain)
- Multiple booking pages
- Group bookings
- Recurring appointments
- Zapier + webhook integrations
- File uploads (5 GB)
- API access (100,000 calls/day)

### Business — $129/mo (annual) · $179/mo (monthly)
- Unlimited employees
- Unlimited bookings
- Unlimited notifications
- Multiple locations
- Team assignment rules (round-robin, load-balanced, skills-based)
- Custom fields + intake forms
- Advanced analytics + reporting
- Priority support
- SSO (SAML/OIDC)
- API access (unlimited)

---

## Feature Map

### Booking Engine
- [ ] Public booking page with available time slots
- [ ] Service selection (single service, or multi-service wizard)
- [ ] Employee/provider selection (or auto-assign)
- [ ] Duration-based availability calculation
- [ ] Buffer time between appointments (configurable per service)
- [ ] Booking confirmation with email/SMS
- [ ] Booking cancellation + rescheduling (with policy enforcement)
- [ ] Waitlist when slots are full
- [ ] Recurring bookings (weekly, biweekly, monthly)
- [ ] Group/class bookings (limited capacity)
- [ ] Embeddable widget (iframe + web component)

### Calendar & Availability
- [ ] Per-employee weekly availability schedule
- [ ] Date-specific overrides (holidays, sick days)
- [ ] Break/lunch blocks
- [ ] Google Calendar two-way sync
- [ ] Outlook/Office 365 two-way sync
- [ ] Apple Calendar sync (read-only via CalDAV)
- [ ] Conflict detection across synced calendars
- [ ] Timezone-aware display (auto-detect visitor timezone)

### Payments
- [ ] Stripe integration (full prepayment or deposit)
- [ ] PayPal integration
- [ ] LemonSqueezy integration
- [ ] No-show fees
- [ ] Cancellation refund policies (full, partial, none)
- [ ] Invoicing (auto-generate PDF)
- [ ] Subscription/package pricing (e.g., 10-session pack)
- [ ] Discount codes / vouchers

### Customer Management
- [ ] Customer directory with search + filter
- [ ] Booking history per customer
- [ ] Customer notes (internal, not visible to customer)
- [ ] Customer tags / segments
- [ ] Import/export (CSV)
- [ ] GDPR data export + deletion

### Notifications
- [ ] Email confirmations (booking, cancellation, reschedule)
- [ ] SMS confirmations
- [ ] Reminder emails (configurable: 24h, 1h, custom)
- [ ] Reminder SMS
- [ ] Follow-up emails (post-appointment)
- [ ] Customizable email templates (HTML editor)
- [ ] Notification logs

### Team & Employee Management
- [ ] Employee profiles with individual services + pricing
- [ ] Per-employee availability schedules
- [ ] Employee roles (admin, manager, staff)
- [ ] Auto-assignment rules (round-robin, least-busy, skills-based)
- [ ] Employee dashboard (personal schedule view)
- [ ] Employee mobile app (view/manage own bookings)

### Booking Pages / Website
- [ ] Hosted booking page (booksmith.app/slug)
- [ ] Custom subdomain (yourbrand.booksmith.app)
- [ ] Custom domain (book.yourbrand.com) — Pro+
- [ ] Page builder (drag/drop sections: hero, services, team, testimonials, FAQ)
- [ ] Theme customization (colors, fonts, logo)
- [ ] SEO settings (title, description, OG image)
- [ ] Multiple pages per organization

### Integrations
- [ ] Google Calendar
- [ ] Outlook / Office 365
- [ ] Zoom (auto-create meeting links)
- [ ] Google Meet (auto-create meeting links)
- [ ] Microsoft Teams
- [ ] Stripe
- [ ] PayPal
- [ ] Zapier
- [ ] Webhooks (all events)
- [ ] REST API
- [ ] Embeddable widget (JS SDK)

### Analytics
- [ ] Booking volume over time
- [ ] Revenue tracking
- [ ] No-show rate
- [ ] Popular services
- [ ] Busiest times (heatmap)
- [ ] Employee utilization
- [ ] Customer retention / repeat rate
- [ ] Conversion funnel (page view → booking)

### Admin & Settings
- [ ] Organization settings (name, logo, timezone, currency)
- [ ] Billing management (plan, payment method, invoices)
- [ ] Audit log
- [ ] Data export (full account)
- [ ] Account deletion
- [ ] SSO configuration (SAML, OIDC) — Business+
- [ ] Custom roles + permissions — Business+
