# Google Calendar

Use the `google_calendar` tool to manage the user's Google Calendar events.

## Quick Reference

| User Intent | Action | Key Params |
|---|---|---|
| "What calendars do I have?" | `list_calendars` | — |
| "What's on my calendar today?" | `list_events` | `timeMin`, `timeMax` |
| "Show my meetings this week" | `list_events` | `timeMin`, `timeMax` |
| "Find meetings about X" | `search_events` | `query` |
| "Get details for event Y" | `get_event` | `eventId` |
| "Schedule a meeting at 2pm" | `create_event` | `summary`, `start`, `end` |
| "Move my 3pm to 4pm" | `update_event` | `eventId`, `start`, `end` |
| "Cancel my dentist appointment" | `delete_event` | `eventId` |

## Date Formats

- **Timed events**: Use ISO 8601 with timezone — `2025-03-15T14:00:00-05:00`
- **All-day events**: Use `YYYY-MM-DD` — `2025-03-15`
- Always include timezone offsets for timed events. If the user doesn't specify, use their configured `timeZone` or ask.

## Workflow Tips

1. **Before creating**: List events around the target time to avoid conflicts.
2. **Before updating/deleting**: Search or list to find the `eventId` first.
3. **All-day events**: Only provide date (no time component) for start and end. End date should be the day *after* the last day of the event.
4. **Recurring events**: Get/update operations affect single instances by default.

## Auth Errors

If you receive a 401 or "token expired" error, inform the user they need to re-authenticate:
> Your Google Calendar session has expired. Please run the provider setup again to re-authenticate.

If you receive a 403 error, the user may need to enable the Calendar API in their Google Cloud project.
