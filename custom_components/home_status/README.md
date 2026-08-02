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
Experimental Temperature and Humidity providers are configured from
**Configure → Experimental Sensor Providers**. Discovery only lists compatible
entities; users must select each sensor and choose thresholds before Home Status
monitors it. Normal values remain silent unless current-value publication is
explicitly enabled.

Example options-flow setup:

1. Open **Settings → Devices & Services → Home Status → Configure**.
2. Choose **Experimental Sensor Providers**.
3. Select a discovered Temperature or Humidity entity.
4. Enter only the low and/or high limits meaningful for that sensor's native
   unit, then save.

The configuration is stored in the Home Assistant config entry. No YAML or
`.storage` editing is required or recommended.
The bundled NASA RSS adapter is optional and can be disabled with the News
provider. Regional news sources are intentionally not built into the public
package.
