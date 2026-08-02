# Help test a Home Status provider

Community examples help capability providers support the variety of metadata
used by Home Assistant integrations. Please open a GitHub issue with only the
information relevant to the entity being tested.

Useful information:

- Entity domain and a privacy-safe entity ID
- Current state
- Relevant attributes
- `device_class`
- `state_class`
- Unit of measurement
- Home Status diagnostics for the provider
- The behavior you expected Home Status to produce

Please replace personal room, household, person, and device names with generic
labels when they are not needed to reproduce the behavior.

Never include:

- Access tokens, API keys, passwords, or cookies
- Full Home Assistant configuration archives
- Precise coordinates or exact addresses
- Unrelated entities or diagnostics

Home Status should be testable with mocked entity data. Physical access to the
device is not required for a contributor to reproduce provider behavior.
