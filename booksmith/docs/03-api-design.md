# Booksmith — API Design

Base URL: `https://api.booksmith.app/v1`

Authentication: Bearer token (API key) in `Authorization` header.
All responses are JSON. All request bodies are JSON.

---

## Conventions

- Pagination: cursor-based (`?cursor=xxx&limit=25`)
- Filtering: query params (`?status=confirmed&from=2026-01-01`)
- Sorting: `?sort=starts_at&order=desc`
- Errors follow RFC 7807 (Problem Details):
  ```json
  {
    "type": "https://api.booksmith.app/errors/not-found",
    "title": "Not Found",
    "status": 404,
    "detail": "Booking with ID 01HX... does not exist."
  }
  ```
- Rate limiting via `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.
- Idempotency: `Idempotency-Key` header for POST requests.

---

## Endpoints

### Services

```
GET    /services                     List services
POST   /services                     Create service
GET    /services/:id                 Get service
PATCH  /services/:id                 Update service
DELETE /services/:id                 Deactivate service
GET    /services/:id/employees       List employees for service
POST   /services/:id/employees       Assign employee to service
DELETE /services/:id/employees/:uid  Remove employee from service
```

### Employees

```
GET    /employees                    List employees
POST   /employees                    Create employee (invite)
GET    /employees/:id                Get employee
PATCH  /employees/:id                Update employee
DELETE /employees/:id                Deactivate employee
GET    /employees/:id/availability   Get weekly availability
PUT    /employees/:id/availability   Set weekly availability (full replace)
GET    /employees/:id/overrides      List availability overrides
POST   /employees/:id/overrides      Create override
DELETE /employees/:id/overrides/:oid Delete override
GET    /employees/:id/bookings       List employee's bookings
```

### Customers

```
GET    /customers                    List customers (search, filter by tag)
POST   /customers                    Create customer
GET    /customers/:id                Get customer
PATCH  /customers/:id                Update customer
DELETE /customers/:id                Delete customer (GDPR)
GET    /customers/:id/bookings       List customer's bookings
POST   /customers/export             Export customers (CSV)
POST   /customers/import             Import customers (CSV)
```

### Bookings

```
GET    /bookings                     List bookings (filter by date range, status, employee, service)
POST   /bookings                     Create booking
GET    /bookings/:id                 Get booking
PATCH  /bookings/:id                 Update booking (reschedule, add notes)
POST   /bookings/:id/cancel          Cancel booking
POST   /bookings/:id/confirm         Confirm pending booking
POST   /bookings/:id/complete        Mark as completed
POST   /bookings/:id/no-show         Mark as no-show
```

### Availability (Public — for booking pages)

```
GET    /availability                 Get available time slots
       ?service_id=xxx
       &employee_id=xxx             (optional — omit for any available employee)
       &date=2026-03-15             (single date)
       &from=2026-03-15&to=2026-03-21  (date range)
       &timezone=America/New_York
```

Response:
```json
{
  "service": { "id": "...", "name": "60-min Consultation", "duration_mins": 60 },
  "slots": [
    {
      "date": "2026-03-15",
      "times": [
        { "start": "09:00", "end": "10:00", "employee_id": "..." },
        { "start": "10:30", "end": "11:30", "employee_id": "..." },
        { "start": "14:00", "end": "15:00", "employee_id": "..." }
      ]
    },
    {
      "date": "2026-03-16",
      "times": [
        { "start": "09:00", "end": "10:00", "employee_id": "..." }
      ]
    }
  ]
}
```

### Booking Pages

```
GET    /booking-pages                List booking pages
POST   /booking-pages                Create booking page
GET    /booking-pages/:id            Get booking page
PATCH  /booking-pages/:id            Update booking page
DELETE /booking-pages/:id            Delete booking page
```

### Payments

```
GET    /payments                     List payments
GET    /payments/:id                 Get payment
POST   /payments/:id/refund          Refund payment (full or partial)
```

### Notifications

```
GET    /notifications                List notification history
GET    /notifications/:id            Get notification details
```

### Webhooks

```
GET    /webhooks                     List webhooks
POST   /webhooks                     Create webhook
GET    /webhooks/:id                 Get webhook
PATCH  /webhooks/:id                 Update webhook
DELETE /webhooks/:id                 Delete webhook
POST   /webhooks/:id/test            Send test event
```

### Organization / Settings

```
GET    /organization                 Get organization details
PATCH  /organization                 Update organization settings
GET    /organization/billing         Get billing info
POST   /organization/billing/portal  Create Stripe billing portal session
```

### Analytics

```
GET    /analytics/overview           Summary stats (bookings, revenue, no-shows)
       ?from=2026-01-01&to=2026-01-31
GET    /analytics/bookings           Booking volume over time
GET    /analytics/revenue            Revenue over time
GET    /analytics/services           Service popularity breakdown
GET    /analytics/employees          Employee utilization
GET    /analytics/heatmap            Busiest hours/days heatmap
```

---

## Webhook Events

```
booking.created
booking.confirmed
booking.cancelled
booking.rescheduled
booking.completed
booking.no_show
customer.created
customer.updated
customer.deleted
payment.succeeded
payment.failed
payment.refunded
employee.created
employee.updated
```

Webhook payload:
```json
{
  "id": "evt_01HX...",
  "type": "booking.created",
  "created_at": "2026-03-15T10:30:00Z",
  "data": {
    // full booking object
  }
}
```

Signed with HMAC-SHA256 in `X-Booksmith-Signature` header.

---

## Public Booking API (No auth required)

These endpoints power the booking page and embeddable widget. They are scoped to a specific booking page slug.

```
GET    /book/:slug                   Get booking page config (theme, services, employees)
GET    /book/:slug/availability      Get available slots (same params as /availability)
POST   /book/:slug/bookings          Create booking (customer details + slot selection)
GET    /book/:slug/bookings/:id      Get booking status (by booking ID + customer email)
POST   /book/:slug/bookings/:id/cancel  Cancel booking (requires cancellation token from email)
```

---

## Embeddable Widget

```html
<!-- Drop-in widget: 3 lines -->
<div id="booksmith-widget" data-page="your-slug"></div>
<script src="https://cdn.booksmith.app/widget.js"></script>

<!-- Or via npm -->
import { BooksmithWidget } from '@booksmith/widget'
BooksmithWidget.init({ page: 'your-slug', container: '#booking' })
```
