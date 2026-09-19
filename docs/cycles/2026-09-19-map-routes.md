# Cycle 2: quieter routes and precise stop markers

## Problems and planned behavior

The current route map uses 24 × 32 px teardrop pins at every stop. Pins obscure the route and nearby streets, and their implicit bottom anchor makes a stop look displaced from its actual coordinates. Solid route lines have no separation from the basemap. Renderer bookkeeping also assumes every route uses only `INBOUND` / `OUTBOUND`; custom direction keys are missed by visibility and cleanup, while `updateVisibleRoutes` compares those compound keys against plain route IDs.

This task will replace pins with centered circular station dots: white centers, a route-colored ring, subtle dark separation, and a 28 × 28 px transparent interaction area. Visible dot sizes will use three restrained zoom levels, retaining the same click area and stop title. Routes will use a crisp 3.5 px color stroke over a 6 px white casing, with stronger detours above ordinary routes. Stop and route clicks must keep opening the existing information and directions flows.

Renderer storage will identify routes and directions explicitly. Filtering, detours, and cleanup will handle all direction names; duplicate stop IDs within one render batch will create one marker. Overlap selection will check line segments and visible geometry so a click between widely spaced vertices still offers the correct routes.

## Use cases and acceptance

1. **Inspect nearby streets:** at a wide zoom, stop dots are compact and route lines remain legible without a forest of pins. Zooming closer enlarges only the dots; their map positions and click areas remain stable.
2. **Open a stop:** clicking or keyboard-activating a titled stop marker invokes the same stop callback once. Duplicate source records do not stack identical markers.
3. **Follow a route:** its thin color core is separated from roads by a white casing. A route click on either stroke opens the route chooser; overlapping routes are detected along complete line segments.
4. **Filter routes or directions:** the color core, casing, and detours change visibility together. Hidden routes do not appear in an overlap result. Custom direction names and route IDs containing underscores are handled without parsing compound keys.
5. **Switch views repeatedly:** clearing or replacing a route removes every corresponding overlay. Reinitializing on the same provider does not add duplicate zoom listeners, and obsolete-provider zoom events do not touch current markers.

## Verification plan

Use mocked map-provider tests for anchors, sizes, click callbacks, zoom updates, layers, route/direction visibility, duplicate stops, overlap detection, and cleanup. Run focused client tests, TypeScript checks, and lint on portable Node 24.20.0. Root task will visually inspect the local and production maps, then record deployment evidence in the cycle overview.

## Results

Implemented the station-dot helper, route casing, and explicit renderer ownership. Base-route strokes use layers 10/11; stronger orange-red detours use layers 20/21; stops use layer 30, below the live vehicle and personal-location markers. The same stop SVG is reusable by the map key. Marker zoom work occurs only when crossing a size band, and duplicate stop IDs within a batch are discarded before creating map objects.

The route-ID and custom-direction visibility/cleanup problems are fixed. Hidden directions remain hidden when their route is shown again; newly fetched detours inherit that visibility. Replacing geometry during a late color refresh preserves both route and direction filters, while explicitly clearing a route resets its visibility. Overlap selection now checks the complete visible line segment, including between sparse geometry vertices. Invalid coordinates and malformed detour containers/paths are rejected before traversal or creating an overlay, allowing later valid detours to continue rendering. The previously unimplemented route-bounds method now includes current route geometry and stop positions.

Validation on portable Node **24.20.0**: all **23** focused mocked-provider tests passed; client TypeScript checking and focused ESLint passed. Coverage includes station anchoring and click behavior, zoom bands and listener lifecycle, duplicate/invalid stops, both clickable route strokes, GeoJSON and custom directions, route/direction filters, detour layering, overlap selection, replacement/cleanup, late-refresh filter preservation, malformed detour recovery, bounds, and safe SVG colors. A late route-color refresh also updates existing stop rings and their later zoom icons without replacing markers or click listeners. Local/production visual verification and release status are recorded in the cycle overview by the root task.

Known tradeoffs: two polylines per segment provide the white casing and increase map overlay count. Visible stop dots remain intentionally smaller than their stable 28 px interaction target; exceptionally close stops can still overlap, and explicit multi-stop clustering is deferred. Color remains the existing route identity convention; titles, existing stop details, and the map key supplement it.
