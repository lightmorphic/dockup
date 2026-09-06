# Security

Dockup is built for home labs on a private network, not for public
internet exposure. It holds the Docker (or Podman) socket, which is
effectively root on the host - treat access to Dockup itself as
equivalent to root access to the machine it runs on.

## Reporting a vulnerability

Open a private security advisory on the
[GitHub repository](https://github.com/lightmorphic/dockup/security/advisories/new).
Please don't open a public issue for anything that could be actively
exploited.

## What's already in place

- Server-side sessions, rate-limited login, optional TOTP 2FA
- Passwords hashed with Werkzeug's scrypt-based hasher, never stored in plain text
- All other secrets (SMTP credentials, etc.) encrypted at rest with a key
  derived from `SECRET_KEY`, and never echoed back to the browser
- CSRF token required on every state-changing request
- Parameterised SQL throughout - no string-built queries
- Strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, restrictive `Permissions-Policy`
- No analytics, no CDNs, no cookies beyond the session cookie needed to
  be logged in at all
- One external request by design: the Lightmorphic app launcher in the
  top bar loads a script and icons from `apps.lightmorphic.com`, which
  the Content-Security-Policy names explicitly. That script runs with
  the same rights as the rest of the page, so it is a real trust
  decision - remove those two entries from the policy in
  `app/__init__.py`, and the `all-apps` div and script tag from
  `app/templates/app.html`, to drop it

## Supported versions

Only the latest release on the `main` branch is supported. There is no
long-term-support branch - update by pulling the latest image.
