# Changelog

Versions are always `MAJOR.MINOR` with a single-digit minor: `1.0`, `1.1` … `1.9`, then `2.0`.
The newest `## x.y` heading below is the version the app reports, the tag the container
image is published under, and the name of the matching GitHub release (`vX.Y`). Bump it
here and nowhere else.

## 3.2 — 2026-10-01

### Added
- **Change requests**: people can **ask for a change they can't make themselves**, and someone
  who can approves it.
  - **Port VLAN changes**: in the port panel, pick the network and tagging as usual and press
    **Request this change** (with an optional reason). Also works for protected or locked ports
    someone can't change.
  - **PoE power-cycles** (Port tools → *Request*) and **device restarts** (device details →
    *Request a restart*).
  - Requests land on the **Feedback** board (filter *Requests*), seen only by the requester and
    the people who could make that change (the ability, plus access to that environment, device
    and network).
  - **Approve and do it** makes the change as the approver, with the usual confirmations for
    protected, locked and profile ports; the activity log shows who approved it and whose
    request it was. **Decline** takes an optional note for the requester.
  - The requester gets news on the Feedback tab when it's approved or declined, and can
    withdraw it while it waits. One open request per port / device per person.
  - The Feedback tab's count includes **requests waiting for you**, refreshed every minute.
- New abilities under **Requests**: *Request port VLAN changes*, *Request a PoE power-cycle*,
  *Request a device restart*. Off by default; set them per role, per person, or all at once
  in **Feedback → Who can request** (a grid of the people below you).

## 3.1 — 2026-10-01

### Added
- **Feedback board**: a **Feedback** tab next to *Environment* where anyone can **report a bug
  or suggest an idea**, and everyone can see where each one is at.
  - Columns **Open → Planned → In progress → Done**, plus *Won't do* on request. On a phone,
    one column at a time.
  - **Vote** ("me too") instead of posting the same thing twice; sort by most votes, newest or
    recently updated; filter bugs / ideas; search.
  - **Comments** on every item, and an optional **screenshot**: attach one or just paste it
    (Ctrl / ⌘ V).
  - **Technical details** go along by default (version, page, environment, port view, browser,
    screen, theme), visible only to the reporter and whoever handles it. They can be left out.
  - **Status changes** by whoever manages feedback, with an optional note shown in the
    item's activity.
  - **News for you**: when an item you reported, voted for or commented on changes status or
    gets a comment, the tab shows a count and the item is marked until you open it.
  - The reporter can edit or delete their item while it's still open.
- New abilities, under **Feedback** in roles and per person: *See the feedback board*,
  *Report bugs and suggest ideas* (all roles have both, so take them away per person or per
  role to hide the board) and *Manage feedback* (admins).
- **Where do you want to land?**: the start page can now be your environment, the All devices
  page or **Feedback** (setup wizard and Display options).
- **Only what's new**: after an update that adds setup questions, people get a short "A few
  new choices" dialog with just those, instead of the whole setup again.

## 3.0 — 2026-10-01

### Added
- **Branding** (Settings → Branding, admins): make the app yours.
  - **App name**: shown in the top bar, the browser tab, the sign-in page, the setup wizard
    and the installed app's name. It's put into the page by the server, so the stock name
    never flashes on load.
  - **Sign-in tagline**: the line under the name on the sign-in page (or none).
  - **Header logo**: the stock mark, one of **18 icons** on a gradient (**8 palettes** —
    Ocean, Sunset, Forest, Grape, Ember, Gold, Slate, Mono — or **custom** top, bottom and icon
    colors), or an **uploaded picture** (PNG, JPEG or WebP; squared in the browser, see-through
    parts kept).
  - **Browser tab icon**: follows the logo, or its own icon / palette / picture — a simpler
    mark often reads better at 16 pixels.
  - A **live preview** of the browser tab, the top bar and the sign-in card while you edit;
    **Back to stock** undoes it all.
- The installed app (PWA) uses the custom name and logo.

### Changed
- *App name* moved from Settings → Ports to Settings → Branding.

### Security
- Uploaded pictures are checked by their content (no SVG, which could carry script) and served
  with a `default-src 'none'` policy. The name is escaped wherever the server writes it into a page.

## 2.9 — 2026-10-01

### Added
- **Tips now and then**: every few minutes a short tip slides in at the bottom for 15 seconds,
  e.g. *Ctrl / ⌘ click ports to pick several*, *Shift click for a range by port number*,
  *Select ports* on a phone, highlighting a network, Display options, scale, device details,
  matching colors, the All devices page. Tips fit your device (mouse or touch) and what you can
  do; they never cover a dialog or port panel. **Next tip**, **Don't show tips**, and
  Display options → *Show tips now and then*.
- The setup wizard starts with **Night or Day**, shown as two previews you pick from (it
  changes as you click).
- The wizard asks whether to **show or hide networks with no ports**, and says how many there
  are right now.

### Changed
- **The setup wizard can't be skipped**; every step still has *Keep the defaults*.
- **Day / night is saved to your account**, like your other display choices, so it follows you
  to any browser.

## 2.8 — 2026-10-01

### Added
- **Add environment** at the bottom of the environment dropdown, for people who may add
  environments. It opens the new-environment form straight away.
- **Add someone who'll sign in with SSO** (Users → Add user → *Will sign in with SSO*): just
  their display name, email and role. The username is made from their email, and their first
  SSO sign-in finds the account by email.

### Changed
- **Link speeds are short and always fit**: **10M, 100M, 1G, 2.5G, 5G, 10G, 25G**, with
  **FD** or **HD** for full / half duplex (e.g. *1G FD*), in tooltips, the port panel and the
  List view.
- **The version moved to the top bar**, next to the app's name (it used to sit bottom-left and
  got cut off in narrow windows). Click it for *What's new*; it shows the update dot too.
- **The All devices page is purely informational**: nothing on it opens or changes anything.
  Point at a port for its details; switch to *Environment* to make changes.

### Fixed
- **Ports didn't pulse when the operating system asks for reduced motion** (Windows: *Animation
  effects* off — which also applies in incognito windows). The glow doesn't move anything, so
  it now stays on unless you choose **Solid** in Display options. The pulse is also a little
  stronger.
- **Hide ports without link** now works in every view. Tiles, Compact and List leave those
  ports out; the Faceplate keeps the switch's layout and shows an empty socket.

## 2.7 — 2026-10-01

### Added
- **Setup wizard.** It opens once for everyone after this update (after *What's new*), never
  for someone still waiting for setup, and again any time from the menu → **Set up my view**.
  Every step has **Keep the defaults**, and the first has **Skip, keep stock**.
  1. **What to show**: gateways, switches, access points, other network devices, and Protect /
     Access / other UniFi apps, offering only the ones your role allows.
  2. **Your main computer screen**: pick its resolution (this screen is suggested) and see the
     ports as **Faceplate**, **Compact** or **List** on a live example, plus a scale for that
     resolution.
  3. **Your phone**: phone, large phone or **folding phone**, and for a folding phone whether
     you mostly use the **cover** or the **inner** screen (the inner one gets the tablet
     layout), with examples of Tiles, Compact and List.
  4. **Network bubbles**: VLAN number, ports, clients and IP, each off / always / on hover or tap.
  5. **Colors**: pick a color per network, and, with more than one environment, whether to
     **match colors across environments by VLAN number or by name**.
  6. **Last touches**: pulse or solid ports, the All devices page and your start page.
- **Matching colors across environments** (also in **My VLAN colors**): *Separate* (as
  before), *By VLAN* or *By name*. With matching on, a color you pick applies to that VLAN
  number / name everywhere, and the automatic colors match too. Environments stay completely
  separate by default.
- When you haven't picked devices, only the device types you chose in the wizard show.

### Fixed
- The **Compact** port view was squeezed into a narrow column on larger screens.
- Changelog text in *italics*, and **bold** that wraps onto the next line, showed raw
  asterisks in *What's new*.

## 2.6 — 2026-10-01

### Added
- **People who sign in with SSO wait until you set them up.** Someone you haven't added gets
  an account marked **waiting for setup**. Instead of an empty app they see *"Your admin
  hasn't set you up yet. Please contact them"* with a Sign out button, and the page carries on
  by itself as soon as you've set them up.
  - Giving them access to an environment, a role or abilities ends the wait.
  - Users shows a **waiting for setup** badge next to them. Admins and anyone who can give
    access get a banner (*"1 person is waiting for you to set them up"*) and a count on the
    Users button.
- **Add people before they sign in**: under Users → Add user, enter their email (and role,
  then access) without a password. On their first SSO sign-in they're matched to that account
  and are ready to go: no waiting.

### Changed
- An email is only used to match a pre-added person when the identity provider doesn't say
  it's **unverified** (`email_verified: false`), so nobody can claim an account by setting
  someone else's address at the provider.
- Settings → Sign-in: *Let new people sign in with SSO*. On: newcomers get a waiting account.
  Off: only people added under Users can sign in.
- The setup wizard (next release) never starts for someone who's still waiting.

## 2.5 — 2026-10-01

### Added
- **All devices page**: every environment you can open on one long page, with each
  environment's networks, devices (grouped by type) and ports, plus Protect / Access devices.
  - **View only**: click or tap a port and it opens in its environment, ready to change (if
    you may). **Open** jumps to an environment.
  - Each environment can be collapsed. The page keeps itself up to date like the rest of the
    app, and environments are read from UniFi in parallel.
  - Turn it on in **Display options → All devices page**. When it's on it's your **start
    page**; *Start on* can switch that back to your environment. Tabs at the top switch between
    **All devices** and **Environment**.

## 2.4 — 2026-10-01

### Added
- **Wi-Fi on every access point** card (and in its device details):
  - how many clients, split by band (2.4 / 5 / 6 GHz), and the **average signal**
  - the **best** and **worst** client signal, with the client's name, band, SSID and IP, and a
    colored meter: excellent (≥ −60 dBm), good, fair, poor (below −75 dBm)
  - each radio's **channel**, channel width, **how busy** the channel is and its clients
  - **All clients by signal**, worst at the bottom, to find who's struggling
- Network devices with no wired ports, like a meshed access point, show their Wi-Fi instead
  of "no wired ports".

## 2.3 — 2026-10-01

### Added
- **Scale per screen** (Display options → Scale): make the whole app bigger or smaller,
  70 % to 160 %, and it's remembered **for that screen resolution only**.
  - Set 120 % on a 3440 × 1440 monitor, and a 1920 × 1080 screen you sign in on the next day
    stays at 100 % (or its own setting).
  - The resolution is the screen's real one (so Windows display scaling doesn't change it), and
    a phone turned sideways counts as the same screen. A folding phone's cover and inner
    screens are different resolutions, so each keeps its own scale.
  - The slider shows the result live. **Back to stock (100 %)** for this screen, **Reset other
    screens**, and *Reset to defaults* also clears this screen's scale.

## 2.2 — 2026-10-01

### Added
- **Change many ports at once, across switches** (something UniFi's own UI can't do):
  - **Ctrl / ⌘ click** ports to add or remove them, on any switch in the environment.
  - **Shift click** selects a range, by port number (3 to 9 is 3, 4, 5... 9, whichever row
    they're on).
  - On phones and tablets, **Select ports** (next to the environment) turns taps into picking.
    A bar at the bottom counts them; **Change…** opens the editor and **Pick more** goes back.
  - The panel lists the picked ports by switch (remove any with ×). Set one native VLAN and the
    tagging, and **Apply**.
- Bulk changes follow the same rules as one port at a time, and ask **once** for all of them:
  - protected ports need the ability and a confirmation
  - locked ports need the lock ability and stay locked, to the new settings
  - port profiles get detached
  - WAN ports, and ports you may not change, are skipped and listed
  - switches that can't filter tagged VLANs only get the native VLAN
- Each switch is written once, however many of its ports changed. Every port gets its own
  entry in the activity log, marked as a bulk change.
- **Esc** lets go of picked ports.

### Fixed
- On phones, the environment bar no longer squeezes its buttons; the update time is already
  in the top bar.

## 2.1 — 2026-10-01

### Added
- **Port view per screen size**, detected live from the window width, each remembered
  separately on your account:
  - **Phone** (under 600 px)
  - **Tablet or folding phone** (600 – 1099 px)
  - **Laptop or monitor** (1100 – 2199 px)
  - **Ultrawide or 4K** (2200 px and wider)

  Turning a phone sideways or opening a folding phone switches to the next size up. Display
  options shows which one you're on. Your 2.0 phone / larger-screen choices carry over.
- **Big screens are used properly**: device cards sit side by side when they fit, and ports
  grow on ultrawide and 4K screens. **Port size** (Auto, S, M, L, XL) in Display options
  overrides it.
- **Lit ports pulse** gently in their network's color. Display options → *Ports with link*
  → **Solid** turns it off. It's also off when your system asks for reduced motion.
- **WAN ports** have a bronze socket, a gold border and a **large gold globe**.
- **The key is its own section**, collapsible, split into *Ports*, *Marks* and an **example
  network bubble** with each part labelled, and whether it shows always, on hover / tap or
  not at all. It collapses when you close Display options.

### Fixed
- **Marks on ports now pick black or white for each VLAN color** (by contrast, with a soft
  halo), so lock, PoE, uplink and tagging marks stay readable on yellow, white or dark
  networks. Port numbers and VLAN labels get the same treatment.
- The *UniFi device link* mark was drawn as a dark blob.
- The **user menu opened behind the port panel**.
- **Environment and other dropdown lists were unreadable** in the dark theme on some browsers
  (white list, light text).

## 2.0 — 2026-10-01

### Added
- **Protect, Access and other UniFi devices.** Cameras, doorbells, door hubs, readers,
  intercoms, Talk phones... appear in their own sections (*UniFi Protect*, *UniFi Access*,
  ...) with:
  - online / offline, model and IP
  - the **switch port** each is plugged into, a tap away
  - **Restart**: power-cycles that port (with the *Power-cycle PoE* ability)

  Ports with one show a **camera** or **door** mark, the port panel says what's connected
  (e.g. *G4 Bullet · Protect*), and the List view shows it too. They're read from the Network
  app, so no extra keys are needed. They can be hidden in Display options.
- **UniFi app abilities** for each role and person: **Network devices**, **Protect devices**,
  **Access devices** and **Other UniFi devices**.
- **Blanket access per app**: under Users → Access, *Devices they can see* can include
  **All Network / Protect / Access / other UniFi devices**, which covers devices added later
  too, on top of single devices. A device shows only when the person's role allows its app
  *and* their access covers it.
- Managers can only hand out apps and devices they can see themselves.

### Changed
- Upgrading gives every existing role the **Network devices** ability, so everyone keeps
  seeing exactly what they saw in 1.9. Protect, Access and other apps start admin-only, until
  you tick them for a role or a person. A database backup is taken first, as with every
  upgrade.
- The access editor groups devices by app.

## 1.9 — 2026-10-01

### Added
- **Every UniFi network device**, grouped under **Gateways**, **Switches** and **Access
  points** (collapsible; turn grouping off in Display options). Devices without wired ports,
  like a meshed access point, are listed too. Until you choose devices, all of them show.
- **Device details** (the sliders button on each device): model and model code, IP, MAC,
  serial, firmware (and the update UniFi offers), uptime, clients, CPU / memory, what it's
  uplinked to, and whether it can filter tagged VLANs.
- **Managing devices**, for people with the new **Manage devices** ability (admins by
  default):
  - **rename** the device
  - **blink the locate light**, and stop it
  - status light **default / on / off**
  - **restart**, and **update firmware** when UniFi has an update; both ask first
- **Port tools** in the port panel:
  - **port name** (Manage devices), saved to UniFi; a port without settings yet keeps its VLANs
  - **PoE on / off** and **power-cycle** (restarts a camera, phone or access point), for
    people with the new **Power-cycle PoE and turn PoE on / off** ability (admins by default)

  Locked ports need the lock ability, and protected ports need the protected-ports ability and
  a confirmation, just like VLAN changes.
- **The app learns which switches can't do tagged VLANs.** When UniFi refuses a port change
  with *VlanManagementOptionsUnsupportedByDevice*, the app sets just the native VLAN instead,
  says so, and remembers that model as native-only from then on (an admin can undo it in the
  device details).
- **Diagnostics download** (Settings → Environments → an environment): what UniFi reports for
  its devices, with passwords and keys removed. Handy when a model shows up wrong.
- Everything above is in the activity log.
- Devices show **update** and **locating** badges.

### Changed
- The device picker is grouped by type, with **All**, **Switches** and **None** shortcuts.
- Gateways have a darker front and access points a rounder one. On phones a device's stats
  sit on their own row, so long names fit.

## 1.8 — 2026-10-01

### Added
- **Display options** (the sliders button on the Networks box, or the menu): your own choices,
  saved to your account, shown right away.
  - **Network bubbles**: each part can be **Off**, **Always** or **On hover** (on a phone:
    when you tap the bubble):
    - VLAN number
    - **ports on the network**: how many ports have it as their native VLAN, on the devices
      shown
    - **connected clients** on the network (wired and wireless; only for people who see every
      device)
    - **IP subnet**, shown as the subnet (10.0.20.0/24), the gateway IP or gateway/mask
  - Bubble layout: **Wrap**, **One row** (scrolls sideways) or **Grid**. Order by VLAN, name or
    most ports. Optionally hide networks with no ports.
  - **Port views**, chosen separately for phones and for larger screens:
    - **Tiles** / **Faceplate**: as before
    - **Compact**: small squares with the port number in the network's color; tap for details
    - **List**: one row per port with its network, VLAN, link speed, PoE, and what's plugged
      in (or the UniFi device / uplink on the other end)

    Compact and List can hide ports without link. The marks for tagged VLANs on ordinary
    ports can be turned off.
- Hovering a network bubble shows everything about it: VLAN, ports, clients and subnet.
- The key at the bottom shows an **example bubble** with every part labelled, and links to
  Display options.

### Changed
- The networks legend is a tidy box titled **Networks** that can be collapsed. A highlighted
  network stays visible when it's collapsed, and *Clear highlight* is one tap.
- On phones the bubbles wrap onto lines and are smaller, instead of running off the side of
  the screen.
- Turn a phone sideways and big switches are drawn as the real two-row faceplate.

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
