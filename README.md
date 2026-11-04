# rebel-audio-core

The engine room of the Rebels' Companion audio modules. One brain, several mixers. 🍹

Auto level (the thing we used to call the rider), calibrate, button gestures, CLOR pickup for Intech Grid faders, PFL and solo, backup feeds, recording plans and countdowns, the settings store, update checks, and the fader and meter web page. Write a fix here once and every module gets it.

It doesn't know or care what desk it's driving. A module hands it a `Device` (see [`src/device.ts`](src/device.ts)): the device says what each input can do (fader, trim, mute, balance, delay, monitoring, routing, mix option, processing blocks...) and the page, actions and auto level draw themselves from that. No trim? No trim knob. Gain-reduction meters? You get GR bars.

## Who uses it

- [OBS Audio](https://github.com/nisted/companion-module-obs-audio)
- ATEM Audio (coming soon, on Nige's go)

## How a module includes it

Not a package, no build of its own: just TypeScript. Each module adds it as a git submodule at `core/` and bundles it with its own code:

```sh
git submodule add https://github.com/nisted/rebel-audio-core.git core
```

```ts
import { Engine } from '../core/src/engine.js'
import type { Device } from '../core/src/device.js'
```

The module's build runs `node core/scripts/embed-page.mjs` (turns `web/page.html` into `src/page.ts`), and its CI checks out with `submodules: recursive`. Cloning a module? `git clone --recursive`, or `git submodule update --init` afterwards.

## Layout

- `src/device.ts`: the Device interface. Start here.
- `src/engine.ts`: the generic engine (inputs, meters, auto level, pickup, gestures, store, export / import).
- `src/autolevel.ts`: auto level and calibrate for one input.
- `src/settings.ts`: the settings store, with migration from older stores.
- `src/features.ts`: pop-ups, PFL and solo, backup feeds, recording.
- `src/web.ts`, `web/page.html`: the page server and the page.
- `src/law.ts`, `src/pickup.ts`, `src/gesture.ts`, `src/colour.ts`, `src/updates.ts`: the small stuff.
- `test/`: tests against a pretend desk (`test/fake-device.ts`).

## Testing

`corepack enable`, `yarn install`, then `yarn check-types` and `yarn test`.

## Licence

MIT, Nigel Isted. Part of the Rebels: https://github.com/nisted/companion-modules
