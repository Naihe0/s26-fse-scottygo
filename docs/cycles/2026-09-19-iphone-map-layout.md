# iPhone map viewport correction

The user reported a missing app header and a large blank strip below the map in iPhone Chrome immediately on opening the page. The supplied screenshot is the real-device evidence; keyboard interaction was explicitly ruled out as the initial trigger.

## Diagnosis and correction

The map stylesheet fixed both `html` and `body`, sized both to the dynamic viewport, and gave the nested flex map container a percentage height. This created competing root positioning and height constraints. The correction leaves both roots in normal flow, gives the body one dynamic viewport height with a `vh` fallback, and lets the main/map flex containers fill the remainder beneath the non-shrinking header. The map stretches using `inset: 0`. The header and map now have explicit separate stacking levels.

The screenshot alone cannot establish the precise WebKit failure mechanism. This removes the fragile layout rather than introducing browser-specific offsets. No user-agent sniffing, zoom restriction, or JavaScript viewport correction was added.

Related mobile safeguards set editable fields to 16px across phone portrait/landscape widths and give circular controls an explicit foreground/appearance instead of iOS default blue. Landscape QA found the map key covering the copy-view button; the key now sits beside that control column on short, wide screens.

## Validation

- Repository lint, both TypeScript checks, and the production Parcel build passed.
- All 323 existing client tests passed. CSS geometry was verified in the browser, not with source-string assertions or jsdom layout tests.
- At 390 × 664, the header measured top 0/bottom 56 and the map top 56/bottom 664. At 320 × 568, the header remained 56px high and the map ended at 568. Body client and scroll widths matched at both sizes.
- At 844 × 390 landscape, header top remained 0 and map bottom matched the viewport. The map key's left edge was 112px; the copy button ended at 80px, with no overlap.
- The actual local Google map, navigation menu, and route-search results were visually checked. Navigation stayed above map controls. Browser viewport resizing retained the map height chain.
- This is Chromium responsive/layout validation. Physical iPhone Chrome/Safari toolbar, keyboard, rotation, and Back behavior require the user's device confirmation after deployment; the available tools do not operate that iPhone.

## Release

Deployment verification is pending. The change is limited to the map stylesheet and this report; no backend, database, service-plan, or credential changes are needed.
