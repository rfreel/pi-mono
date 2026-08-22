# Clean-room Pi Core

A minimal agent runtime written from scratch. It is intentionally independent of Simsimmer and does not copy Pi internals.

## Contract

- injectable model interface: `model.complete(request)`
- plain-function tools registered by name
- deterministic event trace hook
- explicit abort handling
- explicit tool failures returned to the model
- bounded execution via `maxSteps`
- zero runtime dependencies

## Run

```bash
npm test
npm run check
```

## Next adapters

OptMem and simulation are intended as adapters around this core, not dependencies inside it.
