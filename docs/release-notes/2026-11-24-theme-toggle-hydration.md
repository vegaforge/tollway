---
date: 2026-11-24
feature: Dashboard theme toggle marks when it is ready
scope: fix
packages: []
scenario-impact: none
---

# Dashboard theme toggle marks when it is ready

The dashboard's "the theme choice survives a reload" browser test failed now
and then in CI, most often in the dark project, on pull requests that never
touched the dashboard.

The theme toggle can only know the theme after React mounts it. Until then the
server's markup says "not pressed" even in dark mode, and a click has no
handler. The test read the toggle's state and clicked it as soon as the button
appeared, so on a slow runner it read the wrong state or lost the click.

The toggle now carries `data-ready="true"` once it has mounted, and the test
waits for it before reading or clicking, both on the first load and after the
reload. With the page's scripts held back to force the race, the old test
fails and the new one passes. Nothing a user sees changes.
