# Changelog

Versions are always `MAJOR.MINOR` with a single-digit minor: `1.0`, `1.1` … `1.9`, then `2.0`.
The newest `## x.y` heading below is the version the app reports, the tag the container
image is published under, and the name of the matching GitHub release (`vX.Y`). Bump it
here and nowhere else.

## 1.2 — 2026-09-30

### Added
- **Port locks**: an admin can lock a port from its port panel, with an optional note like
  "Upstream trunk from core port 17".
  - The port is locked to the settings UniFi has right now.
  - Everyone sees a lock on the port. Supervisors can't change it, whatever their other rights.
  - Admins can still change a locked port after a confirmation, and it stays locked to the
    new settings.
  - **Drift**: if a locked port is changed in the UniFi UI, it shows a warning. Admins get a
    **Re-apply locked settings** button that puts it back.
  - Locks are kept by switch MAC, so they survive a re-adoption.
  - Locking, unlocking and re-applying are in the activity log.
- **Redirect URI box** in Settings → Sign-in, shown before anything else is filled in. It has:
  - the exact redirect URI to paste into your provider, with a copy button
  - the launch URL
  - a warning, with a one-click fix, if the app sees a different address than your browser
    (a reverse proxy not passing the hostname)

### Fixed
- **Stuck loading screen after an update.** A browser, home-screen app or caching proxy
  (for example Nginx Proxy Manager's "Cache Assets") could keep serving the old scripts.
  - Scripts and styles now load from a URL that changes with every release, so an old copy
    can't be used.
  - A page or installed app left open during an update reloads itself when it notices the
    new version.
  - If the app ever fails to start, it now shows the error and a Reload button instead of
    spinning.
- Wrapped bullet lines in this changelog now display as one line.

### Changed
- Automatic protection (uplinks, device links, LAG/mirror) now shows a shield icon, so it's
  easy to tell apart from an admin's lock.

## 1.1 — 2026-09-30

### Added
- **Environments**: one app for many UniFi consoles. Each environment is a UniFi console or a
  UniFi OS instance (for example one per technician's staging rack), with its own API key.
  - Admins add, test, change and remove environments under Settings → Environments.
  - Only admins ever see or set API keys. Keys never reach the browser.
- **Access per user and environment**: under Users → Access, admins pick which environments
  each person gets. Inside each one they can pick:
  - which **networks** that person may put on a port (the rest never show up as a choice)
  - which **devices** that person sees
- With a network allow-list, **Allow All** tagging is unavailable because it would tag networks
  the user doesn't have. **Custom** tagging only ever includes allowed networks.
- Device access is stored by MAC, so a switch that's forgotten and re-adopted keeps its access.
- **Environment switcher** at the top when you have more than one environment. Device choices
  and collapsed cards are remembered per environment.
- **About this environment** (supervisors): the connection, site, notes and your own access,
  read-only.
- Per environment, admins can let supervisors change protected ports (uplinks, device links,
  LAG/mirror ports).
- Default VLAN colors are now set per environment.
- **Rename users**: admins can change anyone's username, including the first `admin`.
  Everyone can edit their own display name under My account.
- **Stays in sync with the UniFi consoles**:
  - The app refreshes when you come back to it (phone unlocked, tab focused).
  - An open port panel follows changes made in UniFi until you start editing.
  - If a port was changed in UniFi after you opened it, you're asked before your change
    replaces it.
  - The default refresh interval is now 10 seconds.

### Changed
- **Roles are scoped to environments.** Supervisors change ports and read the settings of the
  environments they're given, and see the activity log for those environments only.
  Viewers only see their devices.
- **SSO only signs people in.** Roles and access always come from an admin in the app. The
  "admin groups / supervisor groups" SSO options are gone. New SSO users start as Viewer
  with no environments. "Allowed groups" still limits who may sign in at all.
- Upgrading from 1.0 turns the existing UniFi connection into an environment called
  **Default**, with its API key and VLAN colors. A backup of the database is taken first, as
  with every upgrade.
- The activity log shows which environment each change was in, and records environment and
  access changes.

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
