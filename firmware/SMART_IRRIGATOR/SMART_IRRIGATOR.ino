/*
  SMART IRRIGATOR - ESP32 DevKit + Firebase Realtime Database
  Arduino IDE sketch

  Library: Firebase-ESP32 by Mobizt (legacy library, as requested).
  The ESP32 must have normal Wi-Fi INTERNET access. It writes to Firebase's
  cloud endpoint, so the phone never connects to the ESP32's local IP address.
*/

#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <FirebaseESP32.h>


// This local file contains Wi-Fi and Firebase credentials. It is deliberately
// ignored by Git; copy secrets.example.h to secrets.h and fill it locally.
#include "secrets.h"

// Pins
constexpr uint8_t SOIL_PIN = 34;       // ADC input-only pin; sensor MUST be powered at 3.3 V
constexpr uint8_t RED_LED_PIN = 27;
constexpr uint8_t GREEN_LED_PIN = 14;
constexpr uint8_t BUZZER_PIN = 25;
constexpr uint8_t RELAY_PIN = 26;

// Your earlier working sketch used HIGH = pump ON, so preserve that relay behavior.
constexpr bool RELAY_ACTIVE_LOW = false;

// ========== RECALIBRATE THESE on actual ESP32 hardware ==========
// ESP32 ADC readings are 12-bit: 0 to 4095. This sketch assumes a DRY reading
// is HIGHER than a wet reading, which is common for resistive modules. Reverse
// the comparison in isDryReading() if your tested sensor behaves oppositely.
constexpr int defaultDryThreshold = 2600;
constexpr int wetThreshold = 2000;     // Must be lower than dryThreshold: hysteresis gap.
// A farmer may approve an earlier-watering threshold, but never a value that
// crosses the wet threshold or is drier than the originally tested setting.
constexpr int minimumApprovedDryThreshold = wetThreshold + 150;
constexpr int maximumApprovedDryThreshold = defaultDryThreshold;
// ================================================================

// Easy-to-adjust pulsed-irrigation timings.
constexpr unsigned long pulseDuration = 5000UL; // 5 seconds
constexpr unsigned long settleDuration = 6000UL; // 6 seconds; pump cannot restart here
constexpr unsigned long firebasePublishInterval = 3000UL;
constexpr unsigned long firebaseCommandInterval = 750UL;
constexpr unsigned long lcdInterval = 300UL;
// One history point every five minutes keeps the chart useful without flooding
// Firebase. Pump/status changes are also recorded immediately as events.
constexpr unsigned long historyInterval = 5UL * 60UL * 1000UL;

// Change 0x27 to 0x3F if your I2C scanner finds that address.
LiquidCrystal_I2C lcd(0x27, 16, 2);
FirebaseData firebaseData;
FirebaseAuth firebaseAuth;
FirebaseConfig firebaseConfig;

enum IrrigationState { MONITORING, PULSING, SETTLING };
IrrigationState irrigationState = MONITORING;

int moisture = 0;
int activeDryThreshold = defaultDryThreshold;
bool soilIsDry = false;       // Retained in the hysteresis gap.
bool manualOverride = false;
bool manualPumpState = false;
unsigned long stateStartedAt = 0;
unsigned long lastPublishAt = 0;
unsigned long lastCommandAt = 0;
unsigned long lastLcdAt = 0;
unsigned long lastHistoryAt = 0;
unsigned long lastAdaptiveSampleAt = 0;
int previousAdaptiveMoisture = -1;
int moistureAtPulseStart = -1;
float averageDryingRatePerHour = 0.0F;
float averagePulseRecovery = 0.0F;
String previousHistoryPumpState = "";
bool previousHistoryDryState = false;

bool isDryReading(int value) {
  return value >= activeDryThreshold;
}

bool isWetReading(int value) {
  return value <= wetThreshold;
}

void setPump(bool on) {
  digitalWrite(RELAY_PIN, (on == RELAY_ACTIVE_LOW) ? LOW : HIGH);
}

bool pumpIsOn() {
  if (manualOverride) return manualPumpState;
  return irrigationState == PULSING;
}

const char* pumpStateText() {
  if (manualOverride) return manualPumpState ? "ON" : "OFF";
  if (irrigationState == PULSING) return "ON";
  if (irrigationState == SETTLING) return "SETTLING";
  return "OFF";
}

const char* lcdStateText() {
  if (manualOverride) return manualPumpState ? "Pulsing" : "Manual OFF";
  if (irrigationState == PULSING) return "Pulsing";
  if (irrigationState == SETTLING) return "Settling";
  return soilIsDry ? "DRY" : "WET";
}

void updateIndicators() {
  // Red LED and active buzzer warn whenever the soil is currently dry;
  // green LED is on only when the moisture status is wet.
  digitalWrite(RED_LED_PIN, soilIsDry ? HIGH : LOW);
  digitalWrite(GREEN_LED_PIN, soilIsDry ? LOW : HIGH);
  digitalWrite(BUZZER_PIN, soilIsDry ? HIGH : LOW);
}

void readManualCommands() {
  if (millis() - lastCommandAt < firebaseCommandInterval || !Firebase.ready()) return;
  lastCommandAt = millis();

  if (Firebase.getBool(firebaseData, "/aquasense/manualOverride")) {
    manualOverride = firebaseData.boolData();
  }
  if (Firebase.getBool(firebaseData, "/aquasense/manualPumpState")) {
    manualPumpState = firebaseData.boolData();
  }
  // The app writes this only after the farmer explicitly confirms approval.
  // Invalid values are ignored so a bad database write cannot cause flooding.
  if (Firebase.getInt(firebaseData, "/aquasense/approvedDryThreshold")) {
    int requestedThreshold = firebaseData.intData();
    if (requestedThreshold >= minimumApprovedDryThreshold &&
        requestedThreshold <= maximumApprovedDryThreshold) {
      activeDryThreshold = requestedThreshold;
    }
  }

  // Entering manual mode cancels any automatic pulse/settling timer immediately.
  if (manualOverride) irrigationState = MONITORING;
}

void runAutomaticStateMachine() {
  if (manualOverride) return; // Manual override completely bypasses threshold logic.

  switch (irrigationState) {
    case MONITORING:
      if (soilIsDry) {
        irrigationState = PULSING;
        stateStartedAt = millis();
        moistureAtPulseStart = moisture;
      }
      break;
    case PULSING:
      if (millis() - stateStartedAt >= pulseDuration) {
        irrigationState = SETTLING;
        stateStartedAt = millis();
      }
      break;
    case SETTLING:
      // Deliberately do not inspect the threshold to restart during this period.
      if (millis() - stateStartedAt >= settleDuration) {
        // Measure the pulse after the soil has had time to absorb water. This
        // drives a recommendation; it cannot change thresholds by itself.
        if (moistureAtPulseStart >= 0) {
          float recovery = (float)(moistureAtPulseStart - moisture);
          if (recovery > 0) {
            averagePulseRecovery = averagePulseRecovery == 0.0F
              ? recovery
              : (averagePulseRecovery * 0.8F) + (recovery * 0.2F);
          }
          moistureAtPulseStart = -1;
        }
        irrigationState = MONITORING;
      }
      break;
  }
}

void publishToFirebase() {
  if (!Firebase.ready() || millis() - lastPublishAt < firebasePublishInterval) return;
  lastPublishAt = millis();

  // An atomic update prevents the app from seeing a partially-updated status set.
  FirebaseJson update;
  update.set("moisture", moisture);
  update.set("status", soilIsDry ? "DRY" : "WET");
  update.set("pumpState", pumpStateText());
  update.set("lastUpdated/.sv", "timestamp"); // Firebase server time, milliseconds since Unix epoch.

  // The adaptive model only recommends a threshold. The active threshold
  // changes only when the farmer confirms a valid value in the app.
  int adaptiveAdjustment = constrain((int)(averageDryingRatePerHour / 100.0F) * 25, 0, 200);
  int suggestedDryThreshold = constrain(defaultDryThreshold - adaptiveAdjustment,
    minimumApprovedDryThreshold, maximumApprovedDryThreshold);
  update.set("insights/currentDryThreshold", activeDryThreshold);
  update.set("insights/suggestedDryThreshold", suggestedDryThreshold);
  update.set("insights/dryingRatePerHour", averageDryingRatePerHour);
  update.set("insights/pulseRecovery", averagePulseRecovery);
  update.set("insights/mode", "FARMER_APPROVAL_REQUIRED");
  update.set("insights/lastCalculated/.sv", "timestamp");

  if (!Firebase.updateNode(firebaseData, "/aquasense", update)) {
    Serial.print("Firebase publish failed: ");
    Serial.println(firebaseData.errorReason());
  }
}

bool appendHistory(const char* eventName) {
  if (!Firebase.ready()) return false;

  FirebaseJson record;
  record.set("moisture", moisture);
  record.set("status", soilIsDry ? "DRY" : "WET");
  record.set("pumpState", pumpStateText());
  record.set("event", eventName);
  record.set("timestamp/.sv", "timestamp");

  if (!Firebase.pushJSON(firebaseData, "/aquasense/history", record)) {
    Serial.print("Firebase history failed: ");
    Serial.println(firebaseData.errorReason());
    return false;
  }
  return true;
}

void updateAdaptiveModel() {
  unsigned long now = millis();
  if (previousAdaptiveMoisture >= 0 && lastAdaptiveSampleAt > 0) {
    unsigned long elapsed = now - lastAdaptiveSampleAt;
    // Higher ADC readings mean drier soil in this project. Ignore readings
    // during a pump cycle, because they do not represent natural drying.
    if (elapsed > 0 && irrigationState == MONITORING && !manualOverride) {
      int delta = moisture - previousAdaptiveMoisture;
      if (delta > 0) {
        float hourlyRate = ((float)delta * 3600000.0F) / (float)elapsed;
        averageDryingRatePerHour = averageDryingRatePerHour == 0.0F
          ? hourlyRate
          : (averageDryingRatePerHour * 0.8F) + (hourlyRate * 0.2F);
      }
    }
  }
  previousAdaptiveMoisture = moisture;
  lastAdaptiveSampleAt = now;
}

void recordHistoryIfNeeded() {
  const char* currentPumpState = pumpStateText();
  bool pumpChanged = previousHistoryPumpState != currentPumpState;
  bool soilChanged = previousHistoryPumpState.length() > 0 && previousHistoryDryState != soilIsDry;
  bool due = lastHistoryAt == 0 || millis() - lastHistoryAt >= historyInterval;

  if (!due && !pumpChanged && !soilChanged) return;

  const char* eventName = due ? "SAMPLE" : (pumpChanged ? "PUMP_STATE_CHANGED" : "SOIL_STATUS_CHANGED");
  if (appendHistory(eventName)) {
    updateAdaptiveModel();
    lastHistoryAt = millis();
    previousHistoryPumpState = currentPumpState;
    previousHistoryDryState = soilIsDry;
  }
}

void updateLcd() {
  if (millis() - lastLcdAt < lcdInterval) return;
  lastLcdAt = millis();
  lcd.setCursor(0, 0);
  lcd.print("Moist: ");
  lcd.print(moisture);
  lcd.print("    ");
  lcd.setCursor(0, 1);
  lcd.print("State: ");
  lcd.print(lcdStateText());
  lcd.print("       ");
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  Serial.print("Wi-Fi connected. IP: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  setPump(false); // Safe default: pump off before network setup.

  analogReadResolution(12);
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.print("SMART IRRIGATOR");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");

  connectWiFi();
  // This is the current API for the installed Firebase ESP Client library.
  firebaseConfig.database_url = FIREBASE_DATABASE_URL;
  firebaseConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&firebaseConfig, &firebaseAuth);
  Firebase.reconnectWiFi(true);

  // Create manualOverride/manualPumpState once in the Firebase console (both false).
  // Do NOT reset them here: a reboot must never silently change a remote command.
  stateStartedAt = millis();
}

void loop() {
  // ESP32 ADC1 GPIO34 works while Wi-Fi is active. Do not move this sensor to ADC2.
  moisture = analogRead(SOIL_PIN);

  // Hysteresis: only change the remembered status at either threshold.
  if (isDryReading(moisture)) soilIsDry = true;
  else if (isWetReading(moisture)) soilIsDry = false;

  readManualCommands();
  runAutomaticStateMachine();
  setPump(pumpIsOn());
  updateIndicators();
  updateLcd();
  publishToFirebase();
  recordHistoryIfNeeded();

  // Brief yield; all timing above is non-blocking and uses millis().
  delay(20);
}
