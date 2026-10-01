# Changelog

Versions are always `MAJOR.MINOR` with a single-digit minor: `1.0`, `1.1` … `1.9`, then `2.0`.
The newest `## x.y` heading below is the version the app reports, the tag the container
image is published under, and the name of the matching GitHub release (`vX.Y`). Bump it
here and nowhere else.

## 1.7 — 2026-10-01

### Added
- **Every port says what it is.** Instead of one "tagged VLANs allowed" mark and a shield,
  ports show:
  - **Uplink**, **link to a UniFi device** (with its name), **WAN**, **LAG** or **mirror**
  - on ordinary ports: **all VLANs tagged** (Allow All) or **some VLANs tagged** (Custom)

  So an incoming trunk no longer looks like a normal port that happens to allow tags.
- **"Protected" is explained**: the tooltip, the port panel and the key say it's an uplink /
  device link / WAN / LAG / mirror port, that changing it could cut off what's behind it, and
  who may change it.
- **Switches that can't filter tagged VLANs**, starting with the **USW Flex Mini**: the port
  panel only offers the native VLAN and says why, and only the native VLAN is written to
  UniFi. Admins can mark another model as native-only (or undo it for the Flex Mini) from any
  port panel; it applies to every switch of that model.
- **WAN ports** on gateways are labelled WAN and can't be changed here; their settings live in
  UniFi's Internet settings.

### Changed
- **Official model names**: *USW Flex Mini*, *USW Pro 24 PoE*, *Cloud Gateway Max*,
  *U7 Pro*… instead of UniFi's model codes. Unknown models still show their code.
- **Port type** instead of "Media": *RJ45 · 1 GbE*, *RJ45 · 2.5 GbE*, *SFP+ · 10 Gb*, and
  *· empty* for an SFP cage with no module. It used to show UniFi's raw code ("GE") even
  with nothing plugged in.
- Disabled ports have lighter striping, so big switches look less busy. The key explains it.
- Gateways come first in the device list, then switches, then access points.

### Fixed
- **The sign-in page was cut off on phones.**

## 1.6 — 2026-09-30

### Added
- **UniFi cloud environments work in view-only mode**. Before, they failed at Test connection.
  - Through the cloud you see:
    - your switches and whether they're online
    - each port's link, speed and maximum speed
    - SFP / RJ45 ports
    - PoE on / delivering
  - Port VLANs, VLAN changes, port locks, per-port clients, PoE watts and traffic aren't
    available, because UniFi's cloud only allows its official API.
  - A *View only (UniFi cloud)* banner explains this. The port panel shows status without
    controls, and the server refuses changes too.
  - Every 10 minutes the app checks whether UniFi now allows the full switch API for that
    console, and uses it if so.
- **A popup when you pick UniFi cloud** for an environment lists what works and what doesn't,
  with **Use Direct** / **Use cloud anyway**.

### Changed
- Test connection's last cloud step (switch-port API) is now a warning ("view only") instead of
  a failure, and the result says **Connected, view only** with the device and network count.

## 1.5 — 2026-09-30

### Fixed
- **Cloud environments used the wrong connector address** (`…/consoles/<id>/proxy/network`),
  so every request was refused. They now use the address UniFi documents,
  `api.ui.com/v1/connector/consoles/<id>/network/…`, with the Site Manager key.

### Added
- **Test connection checks cloud setups step by step** and shows each result:
  1. Site Manager API key accepted
  2. Console found on that account, with its UniFi OS version and your role on it
  3. Cloud connector reaches the console's Network app (needs UniFi OS 5.0.3+ and Remote
     Access on)
  4. Switch-port API reachable through the cloud

  A failed step says what to do.

### Known limitation
- UniFi's cloud connector officially only carries the **Integration API**, and that API has no
  way to change a port's VLAN. If step 4 fails for your console, VLAN changes need a
  **Direct** connection: the console's own address and its local API key, reachable from
  this server, for example over a VPN.

## 1.4 — 2026-09-30

### Added
- **Roles & abilities** (Users → Roles & abilities, admins).
  - A role is now a set of **abilities** with a **level**. The level decides who is above
    whom.
  - Abilities:
    - **Ports:** change port VLANs, change protected ports, lock and unlock ports
    - **Environments:** see environment settings, see the activity log
    - **People:** see, add, edit, give access to, change roles and abilities of, delete, and
      view as the people below them
  - **Supervisor** and **Viewer** can be renamed and given any abilities.
  - **Custom roles** (e.g. "Lead tech", level 70) can be added and removed. Their people move
    to another role when a role is deleted.
  - **Admin** always has every ability.
- **Abilities per person** (Users → edit). Each ability can follow the role, or be allowed or
  denied just for that person, e.g. one viewer who may change ports, or one supervisor who
  may not see the activity log.
- **Managing people below you.** People-management abilities only work on people with a
  lower role, and people can only hand out what they have themselves:
  - roles below their own
  - abilities they hold
  - environments, networks and devices from their own access
  - a person's access in environments the manager can't see is left untouched
- Environments and API keys, sign-in settings and editing roles stay **admin-only**, because
  they'd let someone give themselves everything.

### Changed
- Everything that used to check "is admin / is supervisor" now checks the matching ability.
  The defaults keep 1.3's behaviour: Supervisor = change ports, see environment settings,
  see activity; Viewer = look.
- An environment's "Supervisors may change protected ports" switch now applies to everyone
  who can change ports there.
- Sign-in links can be given any role at or below your own, including custom roles.

## 1.3 — 2026-09-30

### Added
- **Profile pictures.** Add or change yours under My account.
  - Photos are cropped to a square and shrunk on your device before upload.
  - Admins can set anyone's picture under Users → edit, and **lock** it so that person can't
    change or remove it.
- **View as** (admins): from Users, see the app exactly as a supervisor or viewer sees it.
  - A banner shows who you're viewing as, with a Stop button.
  - Anything you change meanwhile is logged as "you (as them)".
  - Their own password, sign-in links, picture and preferences can't be changed while viewing
    as them, and admins can't view as other admins.
- **Day / night toggle** (sun / moon) next to the settings gear, for everyone. It's still in
  the menu too.
- **SSO: Test provider now checks the client ID and secret** against your provider and tells
  you whether they're accepted, so an `invalid_client` sign-in failure is explained up front.
  It also picks how they're sent (HTTP Basic or form POST) when your provider only accepts one,
  and there's a new **Client authentication** setting.

### Changed
- **Sign-in links** (My account) are explained in plain language.
  - As you type your own code, the full link shows in a large box, with a live check of the
    length and allowed characters.
  - After creating it, the complete link is shown with a copy button.
  - Script use (the `Authorization: Bearer` header) moved under *More options*.
- **Cloud environments are set up in numbered steps**:
  1. Paste an account API key from unifi.ui.com/api.
  2. Press **Find my consoles**, or paste the address of any unifi.ui.com page of that
     console.

  The console ID is filled in and converted for you. Errors explain when the wrong kind of
  API key is used.
- Failed SSO sign-ins show what's wrong on the login page (client ID/secret rejected, or
  redirect URI mismatch) instead of "check the server log".

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
