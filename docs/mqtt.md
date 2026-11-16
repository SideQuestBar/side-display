# MQTT

SideDisplay can listen to an MQTT broker and show what is published there: a
temperature from a sensor, the level of a keg, a counter kept by a script. It
only ever listens; it publishes nothing.

## Connecting to a broker

Open **Settings → MQTT**, enter the broker's address (for example
`mqtt://192.168.1.10:1883`), a user name and password if the broker asks for
them, then **Test** and **Save**.

- `mqtt://` is a plain connection (port 1883 unless you give another one),
  `mqtts://` an encrypted one (port 8883). The broker's certificate must be
  one the system trusts; for a certificate of your own, point the
  `NODE_EXTRA_CA_CERTS` environment variable at its CA file.
- Brokers that only speak MQTT over WebSocket (`ws://`) are not supported.

The same can be set with `SIDEDISPLAY_MQTT_URL`, `SIDEDISPLAY_MQTT_USERNAME`
and `SIDEDISPLAY_MQTT_PASSWORD`. The settings page wins if both are present.

**As a Home Assistant app**, the broker set up in Home Assistant (usually the
Mosquitto app) is used without any configuration.

SideDisplay must be able to reach the broker; screens do not need to. The
password stays on the SideDisplay server: a display only ever receives the
values of the elements placed on its layouts.

## What you can show

| Element        | Shows                               |
| -------------- | ----------------------------------- |
| **MQTT value** | The last message of one topic, big. |
| **MQTT list**  | Several topics as rows or tiles.    |

Each one takes an exact topic such as `home/kitchen/temperature`. Wildcards
(`+` and `#`) are not accepted: one row shows one topic.

Values update the moment a message is published. SideDisplay subscribes only to
the topics its elements use, so a busy broker costs it nothing.

### Messages in JSON

Many devices publish several values at once:

```json
{ "temperature": 21.4, "humidity": 46, "battery": { "level": 87 } }
```

_Value inside a JSON message_ picks one of them: `temperature`, or
`battery.level`. Items of a list are numbered from 0: `sensors.0.value` or
`sensors[0].value`. Left empty, the whole message is shown.

### Making values readable

- _Unit_ is written after the value; MQTT messages do not carry one.
- _Decimals_ rounds numbers.
- _Rename values_ replaces what devices send with words, for example
  `ON=Open, OFF=Closed`.

## Retained messages

A broker only keeps the last message of a topic when it was published with the
_retain_ flag. Without it, a value appears on screen at the next message, and
is forgotten when SideDisplay restarts. If an element stays empty after a
restart, that is why: have the device publish retained messages, or wait for
its next one.

## Troubleshooting

- **"Not connected"** in Settings: the message next to it comes from the broker
  or the network. Check the address from the machine running SideDisplay, and
  the user name and password.
- **"The broker does not allow reading …"**: the broker's access rules refuse
  that topic to this user.
- **"… is not in the message"**: the JSON message has no such value; check the
  spelling against what the device really publishes (`mosquitto_sub -v -t
  'your/topic'` shows it).
- **An element stays empty**: nothing has been published on the topic yet, or
  the topic is spelled differently (topics are case-sensitive).
