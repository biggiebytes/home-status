# Home Status integration

Home Status normalizes Home Assistant entities and optional information
providers into the single contract published by `sensor.home_status`.

The integration supplies:

- active notifications;
- current household context;
- upcoming schedules;
- recent timeline events;
- profile-aware presentation data for the Home Status card.

Entity and provider behavior is configured through the Home Status config entry.
The bundled NASA RSS adapter is optional and can be disabled with the News
provider. Regional news sources are intentionally not built into the public
package.
