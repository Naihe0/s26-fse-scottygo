// IDs are shared with docs/FEATURES.md. A matching assertion is evidence for
// that assertion's exact behavior; it does not certify every phrase in a flow.
export const suiteGroups = {
  UC01: ['auth-validation', 'register.unit'],
  UC02: [
    'auth-map-handoff',
    'auth-service',
    'loginlogout.unit',
    'auth-rate-limit.unit'
  ],
  UC03: ['map-guide-flow', 'map-key', 'feedback'],
  UC04: [
    'map-location-recovery',
    'location-feedback',
    'location-search-recovery',
    'place-suggestions',
    'geolocation-controller',
    'planned-location-storage'
  ],
  UC05: [
    'map-filter-controls',
    'route-control-interactions',
    'transit-startup-recovery',
    'map-appearance',
    'map-appearance-panel',
    'map-focus',
    'google-map-provider'
  ],
  UC06: [
    'map-hit-test',
    'map-selection-provider',
    'map-selection',
    'route-renderer'
  ],
  UC07: ['transit-search'],
  UC08: ['nearby-stops-panel', 'nearby-stop-actions', 'transit-api-errors'],
  UC09: ['route-explorer'],
  UC10: [
    'prediction-requests',
    'prediction-shortcuts',
    'stop-boarding',
    'arrival-identity'
  ],
  UC11: ['vehicle-motion-replay', 'vehicle-motion-tracker', 'vehicle-tracker'],
  UC12: [
    'directions-controller',
    'walking-directions.service',
    'directions-restoration'
  ],
  UC13: ['rider-shortcuts', 'rider-shortcuts-store'],
  UC14: [
    'copy-view-link',
    'stop-link-navigation',
    'map-auth-return',
    'url-sync',
    'map-navigation'
  ],
  UC15: ['subscriptions', 'map-subscription-session'],
  UC16: [
    'notification-rendering',
    'notification-inbox',
    'agency-window',
    'alert-content',
    'alert-metadata.unit'
  ],
  UC17: ['live-notification-stack', 'live-notification-lifecycle'],
  UC18: ['frontend-accessibility', 'live-notification.unit'],
  UC19: ['manageacct.unit'],
  UC20: ['transit-feed-lifecycle.unit']
};

// Only assertions from this UC's listed suites can match these expressions.
// Exact titles and file paths are retained in each result for human review.
export const alternateFlows = {
  UC01: [
    ['Validation, reveal and email completion', 'valid|reveal|campus|email'],
    [
      'Terms preview and registration review cancellation',
      'terms|draft|agreement'
    ],
    [
      'Duplicate or partial registration failure',
      'existing|duplicate|failed|failure'
    ]
  ],
  UC02: [
    ['Protected public link handoff', 'handoff|shared|return'],
    [
      'Rejected sign-in and rate limiting',
      'wrong|invalid|inactive|throttl|rate|missing'
    ],
    ['Unagreed account acceptance or rejection', 'terms|agree'],
    ['Expired or replaced session', 'session|token|expired|switch|revoke']
  ],
  UC03: [
    ['Skip and replay', 'replay|tour'],
    ['Topics, back and focus', 'topic|focus|keyboard|dismiss']
  ],
  UC04: [
    ['GPS failure and recovery', 'denied|retry|recover|timeout|unavailable'],
    ['Alternate planned origin', 'planned|campus|custom|Places New|place|suggestion|token|SDK'],
    [
      'Saved stop and return to GPS',
      'saved platform|Current Location|saved stop'
    ]
  ],
  UC05: [
    ['Route draft and picker navigation', 'draft|route|cancel|search'],
    [
      'Systems, directions and schedule state',
      'system|direction|filter|detour'
    ],
    [
      'Appearance and focus preferences',
      'appearance|satellite|focus map|storage|contrast'
    ],
    [
      'Startup or geometry failure',
      'failed|failure|unavailable|timeout|missing|retry'
    ]
  ],
  UC06: [
    ['Choice type, query and zoom', 'choos|filter|zoom|query|search'],
    [
      'Density, deduplication and selected target',
      'dens|deduplicat|selected|zoom'
    ],
    ['Dismiss and restore focus', 'Escape|focus|dismiss']
  ],
  UC07: [
    ['Scope, exact ID and disambiguation', 'scope|exact|groups|mixed'],
    ['Clear and keyboard selection', 'clear|Arrow|Enter|Escape|keyboard'],
    [
      'Races, empty results and retry',
      'late|rapid|empty|error|retry|timeout|stalled'
    ]
  ],
  UC08: [
    ['Discovery area, range and query', 'area|range|route|filter'],
    ['Preview more, compare boarding and save', 'preview|walk|reachable|save'],
    [
      'Empty or partial discovery failure',
      'failed|retry|empty|unavailable|failure'
    ]
  ],
  UC09: [
    [
      'Stop direction, query and transfer',
      'stop.*direction|search|transfer|nearest|distance'
    ],
    [
      'Bus matching and ordering',
      'bus.*filter|bus.*direction|bus rows|vehicle refresh'
    ],
    [
      'Empty, failed or cancelled route data',
      'empty|failed|hanging|late|detach|cancel'
    ]
  ],
  UC10: [
    ['Arrival selection, paging and time view', 'select|window|viable|arrival'],
    [
      'Repeated visits and revised estimates',
      'repeat|visit|ETA|departure|estimate'
    ],
    [
      'Unavailable or warming feed and recovery',
      'unavailable|warming|cached|stale|failed|recover|timeout'
    ],
    ['Minimize, save and share a platform', 'minimize|restore|save|share']
  ],
  UC11: [
    ['Bus details and actions', 'popup|card|stop|report|detail'],
    ['Follow, drag and resume', 'follow|drag|pause|resume'],
    [
      'Motion replay and feed failures',
      'stale|missing|correct|outage|reduced|replay|duplicate|noise'
    ]
  ],
  UC12: [
    ['Planned origins and compact walking view', 'planned|instruction|steps'],
    [
      'Loading cancellation and failed routing',
      'cancel|loading|failure|fails|denial|timeout|abort'
    ],
    ['Deviation, reroute and arrival', 'deviation|rerout|arrival'],
    [
      'Historical selected departure during an outage',
      'unavailable bus predictions|historical|stale'
    ]
  ],
  UC13: [
    ['Saved stop controls', 'saved stop|nickname|share|starting point|nearby discovery'],
    ['Named places and views', 'named|rename|planning location|view|place location|place draft|place boarding'],
    ['Recent selections and history', 'recent|history'],
    [
      'Storage capacity, account separation and undo',
      'capacity|limit|storage|account|Undo|undo|restor'
    ]
  ],
  UC14: [
    [
      'Share cancellation and clipboard fallback',
      'native|clipboard|cancel|copy'
    ],
    ['Sign-in and unavailable exact stop', 'sign-in|missing|exact|unavailable'],
    [
      'History and navigation restoration',
      'history|back|forward|restor|navigation'
    ]
  ],
  UC15: [
    [
      'Subscription filters and operator picker',
      'filter|sort|system|operator|saved'
    ],
    ['Mute, unmute and remove', 'mute|remove|delete'],
    [
      'Save rejection, limits and concurrency',
      'duplicate|limit|failed|retry|concurren|ten'
    ]
  ],
  UC16: [
    [
      'Combined notice and rider filters',
      'filter|window|severity|route|topic|search'
    ],
    ['Expand, follow links and share', 'link|expand|share|source|platform'],
    ['Read state and changed notices', 'read|changed|updated|receipt'],
    ['Failure and retained reading state', 'fail|retry|refresh|retain|preserv']
  ],
  UC17: [
    ['Foreground reading and dismissal', 'focus|pause|dismiss|reading'],
    [
      'Muted, duplicate and overflowing events',
      'mute|duplicate|burst|overflow'
    ],
    [
      'Reconnection or session transition',
      'reconnect|session|subscription|account'
    ]
  ],
  UC18: [
    ['Review, edit and discard report drafts', 'skip|draft|review|back|clear'],
    ['Invalid report and retry', 'empty|limit|failed|retry|comment'],
    [
      'GPS and vehicle report eligibility',
      'GPS|location|stale|distan|proximity'
    ],
    ['Moderation and unchanged conditions', 'moderat|unchanged|notification']
  ],
  UC19: [
    [
      'Profile validation and cancellation',
      'valid|email|username|partial|cancel'
    ],
    ['Password and session revocation', 'password|session|token'],
    ['Self-deactivation safeguards', 'inactiv|deactiv|status'],
    [
      'Administrator changes and authorization',
      'admin|privilege|unauthor|forbidden|reset'
    ]
  ],
  UC20: [
    ['Native navigation and recovery', null],
    ['Operator dashboard interactions', null],
    ['Feed lifecycle and readiness', 'feed|start|stop|poll|health|ready']
  ]
};

export const deviceOnly = [
  {
    flowId: 'UC03-A2',
    checks: ['Physical rotation and VoiceOver focus'],
    status: 'not-exercised',
    reason: 'No attached iPhone automation'
  },
  {
    flowId: 'UC04-A1',
    checks: ['iOS permission sheet and device-level GPS accuracy'],
    status: 'not-exercised',
    reason: 'Browser fixture supplies GPS'
  },
  {
    flowId: 'UC06-A2',
    checks: ['Physical pinch and overlapping finger targets'],
    status: 'not-exercised',
    reason: 'Browser viewport emulation only'
  },
  {
    flowId: 'UC12-A3',
    checks: ['Walk a physical route and observe live GPS rerouting'],
    status: 'not-exercised',
    reason: 'Controlled positions and paths'
  },
  {
    flowId: 'UC14-A1',
    checks: ['Native iOS share sheet and OS clipboard permission'],
    status: 'not-exercised',
    reason: 'Browser sharing API stub and deterministic policy tests'
  },
  {
    flowId: 'UC17-A3',
    checks: ['iOS app background and OS process restoration'],
    status: 'not-exercised',
    reason: 'Host logic tested without OS execution'
  },
  {
    flowId: 'UC20-M',
    checks: [
      'Launch installed iOS app, sign in, load live map and navigate natively'
    ],
    status: 'not-exercised',
    reason: 'No Xcode or attached iPhone; native host logic only'
  },
  {
    flowId: 'UC20-A1',
    checks: ['OS external-link handoff and actual WebKit process termination'],
    status: 'not-exercised',
    reason: 'Native policy/recovery modules run in Node'
  }
];
