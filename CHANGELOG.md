# Changelog

Versions are always `MAJOR.MINOR` with a single-digit minor: `1.0`, `1.1` … `1.9`, then `2.0`.
The newest `## x.y` heading below is the version the app reports, the tag the container
image is published under, and the name of the matching GitHub release (`vX.Y`). Bump it
here and nowhere else.

## 1.0 — 2026-09-30

First release.

### Switch ports
- Pick which UniFi devices to show (per user, in your own order). Until you pick, all
  switches are shown.
- Each device is drawn as a switch chassis with its name and model, ports laid out like the
  hardware: odd ports on top, even below, SFP cages on the right. On phones the ports wrap
  into a grid of large tap targets instead.
- Every port shows:
  - link up/down and speed
  - PoE: enabled, delivering power (with watts), or off
  - its native VLAN, as the port's color and number
  - whether tagged VLANs are allowed, a port profile, or protection
- Tap a port to set its **native VLAN** from a dropdown of the networks already defined in
  UniFi, and its **tagged VLAN management** (Allow All / **Block All** / Custom).
  Block All is pre-selected by default; admins can change that default.
- Changes are read back from the controller to confirm UniFi stored them.
- Uplinks, links to other UniFi devices, LAG and mirror ports are protected: only an admin can
  change them, after a warning. A port with a port profile asks before the profile is detached.

### VLAN colors
- Every network gets a color. Admins set the defaults; each user can pick their own.
- The legend shows how many ports each network has. Tap a network to highlight the
  ports that carry it.

### Sign-in and users
- Username + password, single sign-on (OIDC: Authentik, Authelia, Keycloak…), and personal API
  tokens, in any combination.
- **SSO auto sign-in**: visiting the app goes straight to your provider, and `/login` always
  shows the login page as a fallback.
- The SSO button's text, colors and icon can be customized, with a live preview.
- Stay signed in for 30 days (adjustable), counted from your last visit.
- Roles: **Admin**, **Supervisor** (changes ports, sees the activity log), **Viewer**
  (read-only). The first admin is created on first start; everyone else starts as Viewer.
  Optionally, SSO groups can set roles.
- Any user, Viewers included, can create their own API tokens, with a random or chosen value.
  A `?token=` link signs a phone or kiosk in, never with more rights than the token has.
  Revoking the token signs those browsers out.
- No-auth mode for isolated lab networks, behind a typed confirmation and shown with a red
  banner on every page.

### Everything else
- Activity log of every port change (who, what, before → after, verified) and every
  user or settings change.
- Works well on phones. Launched from its icon, it opens full screen like an app.
- Dark and light themes.
- Version in the corner. Click it for this changelog, which also opens by itself after an
  update. A pulsing dot means a newer release is out on GitHub.
- Single container, SQLite in a bind-mounted `./data` folder, automatic backup before
  each upgrade, runs as `PUID`/`PGID`.
