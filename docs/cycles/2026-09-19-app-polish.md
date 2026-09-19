# App shell and page polish

## Findings and use cases

The header currently reserves its entire bar for a small menu icon, so the app name is hidden until navigation opens. Its 24 × 18 px menu target is hard to hit on a phone. Navigation does not identify the current page or offer an explicit map entry, and reconnecting the custom element adds another Escape listener. Outside the map, card borders, shadows, text contrast, spacing, and form fields vary across pages. Subscription actions are only 30 px across and the bottom sheet stretches across an entire desktop screen.

This work supports these journeys:

1. A rider recognizes ScottyGo and their current page, opens navigation with a finger or keyboard, and returns directly to the map.
2. A keyboard user sees focus, dismisses navigation with Escape, and does not leave focus inside a closed menu.
3. A rider manages saved routes comfortably on a narrow phone, including mute, remove, and add actions.
4. A returning rider signs in or edits account details in a consistent, readable form; the on-screen keyboard and device safe area do not hide the final action.

## Implementation plan

- Introduce shared brand, surface, text, border, radius, shadow, and focus tokens. Keep the map's fixed viewport and existing map controls intact.
- Retain the compact header height; add a visible home brand, page context, a 44 px menu button, and a contained, neutral navigation panel with the current page identified semantically and visually.
- Keep menu event handlers owned by the component, remove them on disconnect, close after focus leaves, and restore focus only when the user's action warrants it.
- Align authentication, account, and subscription pages with the shared visual language, improve touch targets and form contrast, add short contextual page copy, and give the add-route sheet a readable desktop width.
- Honor reduced motion and safe-area insets on the changed surfaces. Add behavior tests for navigation rather than tests that simply repeat CSS declarations.

## Validation and release

Implemented the plan, including the following additional fixes discovered while applying it:

- Account edit fields now have a real border, so their error border is visible.
- Account selection and active-status controls have accessible names; the status toggle has a visible keyboard focus ring.
- Authentication inputs declare password-manager/autofill purposes and avoid automatic username/email capitalization. Text inputs use 16 px type to avoid focus zoom on iOS.
- The header uses a real button for browser Back and offers Sign in when no local session exists. Its menu button label changes between Open and Close.
- Form dialogs scroll within the available dynamic viewport; changed modal layers stay above navigation. The subscription sheet no longer spans an entire desktop viewport.

Validated on Node 24.20.0:

- 27 tests passed across the new header suite and existing frontend-accessibility, subscriptions, and authentication-validation suites.
- Owned TypeScript files passed ESLint; the full client TypeScript check passed.
- `git diff --check` passed.

Behavior tests cover six current-page variants, explicit map access, session action labels, Escape focus restoration, keyboard navigation out of the menu, outside clicks, reconnection cleanup, and browser Back. CSS is reviewed through the cycle owner's integrated desktop/mobile browser pass rather than assertions that merely duplicate declarations. Browser and production release evidence is recorded in the main cycle report.

## Scope

No data model, authentication protocol, dependency, or map-specific layout changes. Notification rendering and popup styles are owned by the alert workstream. A native iOS wrapper is evaluated separately; this polish remains useful in Safari and a future embedded web view.
