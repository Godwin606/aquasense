# AquaSense — Smart Irrigator

An ESP32-based soil-irrigation system with a Firebase Realtime Database and a React Native/Expo farmer dashboard. The system measures soil moisture, performs pulsed automatic irrigation, supports farmer-approved remote control, stores irrigation history, and presents simple adaptive insights.

> **Submission links**
>
> - Running web system: https://aquasense-grp25.web.app
> - Project repository: https://github.com/Godwin606/aquasense
> - Project website: https://godwin606.github.io/aquasense/ (available after GitHub Pages is enabled)
> - Demonstration video: _add video URL if required_

## Features

- ESP32 soil-moisture monitoring on GPIO34
- Hysteresis-based automatic irrigation: 5-second pump pulse, then 6-second settling period
- Firebase Realtime Database live status and remote manual override
- Expo dashboard for live moisture, pump state, and farmer control
- History timeline and moisture chart
- Rule-based smart daily summary and adaptive threshold recommendation
- Farmer approval required before an adaptive threshold is used

## Architecture

```text
Soil sensor → ESP32 → Wi-Fi → Firebase Realtime Database → Expo mobile/web dashboard
                                      ↑                         │
                                      └── manual commands ───────┘
```

## Repository layout

```text
firmware/SMART_IRRIGATOR/   ESP32 Arduino sketch
mobile/                     Expo / React Native app
firebase/                   Hosting configuration and demo rules
docs/                        Report and poster source content
website/                     GitHub Pages project website (to be added)
```

## Hardware pins

| Component | ESP32 pin |
|---|---:|
| Soil sensor analog output | GPIO34 |
| LCD SDA / SCL | GPIO21 / GPIO22 |
| Red LED | GPIO27 |
| Green LED | GPIO14 |
| Buzzer | GPIO25 |
| Relay input | GPIO26 |

## Run the mobile app

```powershell
cd mobile
npm install
npx expo start
```

For an Android APK, use EAS Build after logging in to Expo.

## Upload firmware

1. Copy `firmware/SMART_IRRIGATOR/secrets.example.h` to `secrets.h` in the same folder.
2. Fill `secrets.h` with local Wi-Fi and Firebase credentials.
3. Install **Firebase ESP Client by Mobizt** and an ESP32-compatible LiquidCrystal I2C library in Arduino IDE.
4. Open `SMART_IRRIGATOR.ino`, select **ESP32 Dev Module**, and upload.

## Deploy the web dashboard

```powershell
cd mobile
npx expo export --platform web
cd ..
firebase login
firebase deploy --only hosting
```

## Security note

`database.rules.demo.json` intentionally permits public read/write access for a single-farmer classroom demonstration. Do **not** use those rules for a public deployment: anyone who learns the Firebase project address could control the pump. Add Firebase Authentication and restrictive database rules before a real deployment.
