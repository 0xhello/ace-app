# ACE Visual Workflow

Use this for real dashboard design work. Do not judge dashboard UI changes from DOM text alone.

## Local setup

The local dashboard is auth-gated. Create/update a low-privilege visual test user in the local SQLite auth DB:

```bash
ACE_VISUAL_PASSWORD='choose-a-local-test-password' npm run visual:user
```

Then save an authenticated Playwright storage state:

```bash
ACE_VISUAL_PASSWORD='choose-a-local-test-password' npm run visual:auth
```

Take a screenshot of the real dashboard:

```bash
npm run visual:shot
```

Default output:

```text
artifacts/dashboard-current.png
```

For before/after work:

```bash
ACE_SCREENSHOT_OUT=artifacts/dashboard-before.png npm run visual:shot
# make real React/CSS changes
ACE_SCREENSHOT_OUT=artifacts/dashboard-after.png npm run visual:shot
```

## Staging or production

Do **not** mutate production auth data with `visual:user`. Use a real low-privilege test account instead:

```bash
ACE_BASE_URL='https://your-ace-url.example' \
ACE_VISUAL_EMAIL='visual-test@example.com' \
ACE_VISUAL_PASSWORD='test-account-password' \
npm run visual:auth

ACE_BASE_URL='https://your-ace-url.example' \
ACE_SCREENSHOT_OUT=artifacts/prod-dashboard.png \
npm run visual:shot
```

## Rules for agents

- No mockups unless explicitly requested.
- No visual claims without real screenshots.
- Use `artifacts/dashboard-before.png` and `artifacts/dashboard-after.png` for dashboard redesign tasks.
- If auth fails, fix the visual workflow first; do not fall back to accessibility-layer-only claims.
- Never commit `.auth/`, screenshots, or passwords.
