# Changelog

## 0.6.9

- Fixed the Home Status card so active appliance cycles are displayed in the live ticker.
- Preserved the existing appliance semantic contract from the native interpreter, including operating state, remaining time, completion, and fault fields.
- Added a cache-version update for the frontend card resource.
- Clarified whole-device appliance setup guidance: select the appliance device, not a separate timer or cycle sensor.
- Normalized the HACS manifest field order.

## Verification

- Live UI verified: `Washer Running` appears with `4 min remaining`.
- Completion and fault presentation require a real appliance completion/fault event and remain the final user-run verification.
