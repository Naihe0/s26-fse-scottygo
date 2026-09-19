# Map provider lifecycle and base map — cycle 2

## Findings and plan

The Google Maps adapter creates an independent animation loop for every marker
position update. A newer update, direct position change, marker removal, or map
clear does not cancel older frames. Overlapping loops can move a bus back toward
an obsolete position and keep work alive after the vehicle is removed. Tiny
moves are discarded entirely, and zero/non-finite animation durations are not
handled explicitly. The adapter also ignores reduced-motion preferences.

The default map gives commercial POIs and Google's transit icons similar visual
weight to ScottyGo's stops and buses. A restrained base map can improve route,
vehicle, and location contrast without removing street or neighborhood context.

Planned use cases and acceptance:

1. A live bus receives a newer position while it is moving: cancel the old frame
   owner and interpolate from its current position to the newest point.
2. A bus disappears, a route changes, or the map clears: cancel pending animation
   work; a stale callback or retained marker handle cannot update a removed bus.
3. A user requests reduced motion: apply marker updates immediately; if the
   preference changes during an animation, finish on its next frame.
4. A tiny move, teleport, missing initial position, or invalid duration arrives:
   set the exact final coordinate without starting an animation.
5. A rider scans the map: use neutral land/roads, pale parks, muted water, and
   quieter commercial/transit icons while retaining useful street, neighborhood,
   park, and medical labels. Layer selection and satellite mode still work.
6. Centered custom marker anchors and icon sizes remain intact on creation and
   updates, so the new circular bus and location glyphs keep their true position.

Implementation starts with the provider and focused adapter tests; integration
adds an optional marker-interactivity field to the map interface. No third-party
account configuration, new dependency, or API key change is required. Style selectors use Google's built-in embedded JSON style schema,
verified against the [official Maps JavaScript style reference](https://developers.google.com/maps/documentation/javascript/style-reference).

## Implemented behavior

The provider now owns at most one animation frame chain per marker. New moves,
direct updates, marker removal, and map clear revoke that ownership and cancel
its pending frame. Each callback independently checks its ownership so a callback
already dispatched before cancellation cannot revive an old move. Retained
handles cannot move removed markers. Small changes reach their exact coordinate
instead of being discarded. Invalid durations and teleports snap immediately.

One cached motion-preference query serves all markers. Reduced motion is checked
when movement starts and on each frame, including preference changes during a
move, without registering permanent event listeners or creating new queries for
every frame.

Embedded base-map styles use neutral roads and land, pale green parks, and muted
blue water. Commercial and built-in transit icons are hidden; street,
neighborhood, park, and medical labels remain available. Existing layer choices
and satellite mode are unchanged. Custom icon size and anchor conversion remains
compatible with the new circular vehicle and location markers.

The marker adapter also forwards the optional `clickable` setting. The larger
GPS marker uses `clickable: false`; ordinary transit markers retain Google's
default behavior. Browser integration showed the SDK still creates a transparent
accessibility image target. A narrowly scoped `pointer-events: none` style for
the named GPS image also lets taps reach the stops under its halo. The actual
overlapping-stop pointer check passed after applying both measures. This CSS
depends on Google's generated role/ARIA markup and should be rechecked after an
SDK migration; the provider unit test establishes option forwarding only.

## Verification

On Node 24.20.0, all 18 mocked Google Maps tests pass. They cover competing move
ownership, already-dispatched stale callbacks, direct updates, removal and both
clear operations, reduced motion and preference changes, missing media-query
support, invalid durations, tiny/teleport endpoints, initial coordinates, custom
icon anchors, noninteractive marker options, style configuration, and layer-mode cycling. Client type checking
and focused ESLint also pass. Visual review and production verification belong
to the parent cycle's final checklist.
