# SideDisplay

Design layouts in your browser and show them on any screen that can open a web
page: a TV, an old tablet, an ePaper frame.

## First steps

1. Start the app and open **SideDisplay** in the sidebar.
2. Create a layout under **Layouts** (start from a template).
3. Create a display under **Displays** and give it that layout.
4. On the screen, open `http://<your Home Assistant address>:4380/d/<display id>`.
   The **Open** and **Copy** buttons on the Displays page give you the exact address.

Screens cannot sign in to Home Assistant, which is why displays use the app's
own port (4380) rather than the sidebar address.

For a screen that runs unattended, DietPi's Chromium kiosk mode (Raspberry Pi
behind a TV) and FreeKiosk (Android tablets) work best:
<https://github.com/SideQuestBar/side-display/blob/HEAD/docs/screens.md>

## Home Assistant data

Nothing to configure: the app talks to your Home Assistant directly. Entity,
calendar, camera, to-do, media player and weather elements pick from your
entities, and any element can be shown only while an entity is in a given state.

## MQTT

If Home Assistant has an MQTT broker (the Mosquitto app), the MQTT elements use
it without any setup. Another broker can be entered under **Settings → MQTT**.

## Managing displays from outside the sidebar

`http://<your Home Assistant address>:4380` also serves the admin interface. It
stays closed until you choose a password under **Settings** (from the sidebar).

## Data and backups

Layouts, displays and uploaded media live in the app's data folder and are part
of Home Assistant backups.

## Notes

- Uploads through the sidebar are limited by Home Assistant's proxy. For large
  videos, sign in on port 4380 and upload there.
- If you change the port in the app's **Network** settings, use that port in
  the display addresses.

More documentation: <https://github.com/SideQuestBar/side-display>
