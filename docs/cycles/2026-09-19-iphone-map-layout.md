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

- Application commit `32b878a647602822de6b6e6dbfc8b7288e3b75ad` was pushed to `codex/render-atlas-setup`. Render deployment `dep-danemrcs728c73aqklm0` reached **Live** after 56 seconds.
- The personal production service serves the new `/map.fd648543.css` stylesheet. Hosted 390 × 664 measurements confirm header top 0/bottom 56, map top 56/bottom 664, and no body horizontal overflow; the navigation menu is accessible above the map.
- All 14 hosted smoke checks passed after transit initialization: pages, frontend assets, fresh PRT/CMU feeds, route lists, Atlas persistence, authentication, and Maps configuration. No test reports or subscriptions were written in production.
- The temporary local app and disposable MongoDB were stopped; no listeners remained on 8080, 8180, 8383, 27017, or 27019. Browser sizing is restored after QA.
- Physical iPhone confirmation was requested from the user after deployment; responsive Chromium checks do not replace that evidence. The rollback target is application `2efa90ecfa368a6d159c2fd77c1d0c718e95ca5d` / Render deployment `dep-dane2lnf3r2c73dvkl7g`.

The release changes only the map stylesheet and documentation. No backend, database, service-plan, or credential changes were made.
