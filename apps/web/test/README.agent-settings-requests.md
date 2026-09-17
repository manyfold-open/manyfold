# Agent Settings Request Boundary

Run `pnpm test:browser-settings` from the core root after the frozen workspace
install and `pnpm exec playwright install chromium`. The existing browser CI
job runs the same command. The test builds the production Settings page,
legacy redirect, auth/i18n providers, styles, and SDK into a real React Router
fixture. Only HTTP responses are faked; all requests outside the fixture
origin are blocked. It reads no credentials and never changes a real agent.

HTTP response barriers cover capability-unknown and unsupported routes,
supported Overview/Model/Storage, permanent aliases, late responses during
agent navigation, and quick section changes. The restore case advances the
browser clock through the actual safety-snapshot polling sequence and checks
the accepted operation remains attached to its original agent after leaving
the page. Leaving Storage before confirmation instead prevents the mutation.

For local visual evidence, set `SETTINGS_SCREENSHOT_DIR` to an absolute output
directory. The runner captures desktop/mobile light/dark preconditions and a
supported Overview, and checks horizontal overflow. Browser processes close
after every case; only the requested screenshot artifacts remain.

After deployment, the release owner should verify the same direct and legacy
URLs using fixture-only external and daemon/sprite agents at the released Web
revision. Record the browser network calls before and after agent resolution,
the precondition, A-to-B navigation, and supported summaries. A backup/restore
integration check must use a disposable workspace and registration. These
deployed checks are separate from the local HTTP-mocked route evidence.
