import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { onValue, ref, update } from 'firebase/database';
import * as Notifications from 'expo-notifications';

import { database } from './firebaseConfig';

// Firebase references for AquaSense
const aquaSenseRef = ref(database, 'aquasense');
const historyRef = ref(database, 'aquasense/history');
const connectionRef = ref(database, '.info/connected');

// Configure local notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard' | 'history'
  const [device, setDevice] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [connected, setConnected] = useState(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // Track previous status to fire notifications when events occur
  const [prevStatus, setPrevStatus] = useState(null);
  const [prevPumpState, setPrevPumpState] = useState(null);

  useEffect(() => {
    // 1. Listen to real-time status node
    const unsubscribeDevice = onValue(
      aquaSenseRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const val = snapshot.val();
          setDevice(val);
          if (typeof val.alertsEnabled === 'boolean') {
            setNotificationsEnabled(val.alertsEnabled);
          }
        } else {
          setDevice(null);
        }
      },
      () => setWriteError('Cannot read Firebase data. Check database rules.')
    );

    // 2. Listen to history node
    const unsubscribeHistory = onValue(historyRef, (snapshot) => {
      if (snapshot.exists()) {
        const val = snapshot.val();
        const list = Object.keys(val).map((key) => ({
          id: key,
          ...val[key],
        }));
        // Sort descending by timestamp
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setHistoryData(list);
      } else {
        setHistoryData([]);
      }
    });

    // 3. Listen to connection state
    const unsubscribeConnection = onValue(connectionRef, (snapshot) => {
      setConnected(snapshot.val() === true);
    });

    // Timer to update relative time ("Updated 5 seconds ago")
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      unsubscribeDevice();
      unsubscribeHistory();
      unsubscribeConnection();
      clearInterval(clock);
    };
  }, []);

  // Handle local notifications on state changes
  useEffect(() => {
    if (!notificationsEnabled || !device) return;

    const currentStatus = device.status;
    const currentPump = device.pumpState;

    if (prevStatus && prevStatus !== currentStatus) {
      if (currentStatus === 'DRY') {
        triggerLocalNotification('Soil Warning', 'Soil has become DRY! Automatic irrigation may trigger.');
      } else if (currentStatus === 'WET') {
        triggerLocalNotification('Moisture Recovered', 'Soil moisture level is now GOOD and wet.');
      }
    }

    if (prevPumpState && prevPumpState !== currentPump) {
      if (currentPump === 'ON') {
        triggerLocalNotification('Irrigation Started', 'The water pump is now actively pulsing water.');
      }
    }

    setPrevStatus(currentStatus);
    setPrevPumpState(currentPump);
  }, [device?.status, device?.pumpState, notificationsEnabled]);

  const toggleNotifications = async (val) => {
    if (val) {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('irrigation-alerts', {
          name: 'Irrigation alerts',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 200, 250],
        });
      }
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please enable notifications in system settings.');
        setNotificationsEnabled(false);
        return;
      }
    }
    try {
      await update(aquaSenseRef, { alertsEnabled: val });
      setNotificationsEnabled(val);
    } catch (error) {
      Alert.alert('Could not save alert setting', error.message);
    }
  };

  const moisture = typeof device?.moisture === 'number' ? device.moisture : null;
  const status = device?.status === 'DRY' ? 'DRY' : device?.status === 'WET' ? 'WET' : '—';
  const pumpState = ['ON', 'OFF', 'SETTLING'].includes(device?.pumpState) ? device.pumpState : '—';
  const manualOverride = device?.manualOverride === true;
  const manualPumpState = device?.manualPumpState === true;

  // Estimate percentage (0-4095 scale where dry > 2600)
  const moisturePercent = useMemo(() => {
    if (moisture === null) return 0;
    return Math.round(100 - (Math.max(0, Math.min(4095, moisture)) / 4095) * 100);
  }, [moisture]);

  // Client-side Free Smart Summary generator
  const smartSummary = useMemo(() => {
    if (!historyData || historyData.length === 0) {
      return 'No historical irrigation records collected yet. System is monitoring live soil data.';
    }

    const last24h = historyData.filter((h) => h.timestamp && now - h.timestamp <= 24 * 60 * 60 * 1000);
    if (last24h.length === 0) {
      return 'Recent sensor activity is normal. Waiting for periodic 5-minute sampling.';
    }

    const pumpEvents = last24h.filter((h) => h.event === 'PUMP_STATE_CHANGED' && h.pumpState === 'ON');
    const dryEvents = last24h.filter((h) => h.status === 'DRY');

    let text = '';
    if (dryEvents.length > 0) {
      text += `Soil reached dry levels ${dryEvents.length} time${dryEvents.length > 1 ? 's' : ''} in the last 24 hours. `;
    } else {
      text += 'Soil moisture remained consistently healthy throughout the day. ';
    }

    if (pumpEvents.length > 0) {
      text += `Automatic irrigation ran ${pumpEvents.length} pulse cycle${pumpEvents.length > 1 ? 's' : ''} and moisture recovered successfully.`;
    } else {
      text += 'No pump pulses were required during this period.';
    }

    return text;
  }, [historyData, now]);

  async function setManualOverride(enabled) {
    setWriting(true);
    setWriteError('');
    try {
      await update(aquaSenseRef, {
        manualOverride: enabled,
        ...(enabled ? {} : { manualPumpState: false }),
      });
    } catch (error) {
      setWriteError(`Could not change manual mode: ${error.message}`);
    } finally {
      setWriting(false);
    }
  }

  async function writeManualPumpState(turnOn) {
    setWriting(true);
    setWriteError('');
    try {
      await update(aquaSenseRef, { manualPumpState: turnOn });
    } catch (error) {
      setWriteError(`Could not change pump: ${error.message}`);
    } finally {
      setWriting(false);
    }
  }

  function requestPumpChange(turnOn) {
    if (!turnOn) {
      writeManualPumpState(false);
      return;
    }
    Alert.alert(
      'Turn pump ON?',
      'This will start the physical water pump remotely.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn ON', style: 'destructive', onPress: () => writeManualPumpState(true) },
      ]
    );
  }

  async function applySuggestedThreshold(suggestedVal) {
    if (!suggestedVal) return;
    setWriting(true);
    try {
      await update(aquaSenseRef, {
        approvedDryThreshold: suggestedVal,
      });
      Alert.alert('Threshold Approved', `The ESP32 will use ${suggestedVal} after its next Firebase check.`);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setWriting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appName}>AquaSense</Text>
        <Text style={styles.subtitle}>SMART IRRIGATOR</Text>

        {/* Tab Navigation Controls */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'dashboard' && styles.activeTabButton]}
            onPress={() => setActiveTab('dashboard')}
          >
            <Text style={[styles.tabText, activeTab === 'dashboard' && styles.activeTabText]}>Dashboard</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'history' && styles.activeTabButton]}
            onPress={() => setActiveTab('history')}
          >
            <Text style={[styles.tabText, activeTab === 'history' && styles.activeTabText]}>History & AI</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.screen}>
        <ConnectionBanner connected={connected} />

        {activeTab === 'dashboard' ? (
          /* ================= DASHBOARD TAB ================= */
          <View style={{ gap: 16 }}>
            {/* Live Soil Moisture Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Soil moisture</Text>
              <View style={styles.moistureRow}>
                <Text style={styles.moistureValue}>{moisture === null ? '—' : moisture}</Text>
                <View style={styles.moistureBadgeContainer}>
                  <Text style={styles.moisturePercentText}>{moisturePercent}%</Text>
                  <Text style={styles.moisturePercentLabel}>Estimated</Text>
                </View>
              </View>
              <Text style={styles.helper}>Raw ESP32 ADC sensor reading (0–4095)</Text>
              <View style={styles.gaugeTrack}>
                <View style={[styles.gaugeFill, { width: `${moisturePercent}%` }]} />
              </View>
              <Text style={styles.updated}>{formatUpdated(device?.lastUpdated, now)}</Text>
            </View>

            {/* Badges */}
            <View style={styles.badgeRow}>
              <StatusBadge label="Soil Status" value={status} color={status === 'DRY' ? '#C62828' : status === 'WET' ? '#2E7D32' : '#607D8B'} />
              <StatusBadge label="Pump State" value={pumpState} color={pumpColor(pumpState)} />
            </View>

            {/* Manual Controls Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Manual control</Text>
              <ControlRow
                title="Manual Override"
                detail="Take direct control away from automatic watering"
                value={manualOverride}
                disabled={writing || connected !== true}
                onChange={setManualOverride}
              />

              {manualOverride ? (
                <ControlRow
                  title="Pump ON/OFF"
                  detail={manualPumpState ? 'Pump is commanded ON' : 'Pump is commanded OFF'}
                  value={manualPumpState}
                  disabled={writing || connected !== true}
                  onChange={requestPumpChange}
                />
              ) : (
                <Text style={styles.automaticNote}>✓ System running in automatic hysteresis mode</Text>
              )}
              {writing && <ActivityIndicator style={styles.spinner} color="#00796B" />}
              {!!writeError && <Text style={styles.error}>{writeError}</Text>}
            </View>

            {/* Adaptive Recommendation Card */}
            {device?.insights && (
              <View style={[styles.card, styles.aiCard]}>
                <View style={styles.aiHeaderRow}>
                  <Text style={styles.aiTag}>FREE AI INSIGHT</Text>
                  <Text style={styles.aiMode}>{device.insights.mode || 'RECOMMENDATION'}</Text>
                </View>
                <Text style={styles.cardTitle}>Adaptive Recommendation</Text>
                <Text style={styles.aiBodyText}>
                  Observed drying rate: <Text style={styles.boldText}>{Math.round(device.insights.dryingRatePerHour || 0)} units/hr</Text>. 
                  Pulse recovery effect: <Text style={styles.boldText}>+{Math.round(device.insights.pulseRecovery || 0)} units</Text>.
                </Text>
                <View style={styles.thresholdRow}>
                  <View style={styles.thresholdBox}>
                    <Text style={styles.thresholdLabel}>Current Dry Threshold</Text>
                    <Text style={styles.thresholdValue}>{device.insights.currentDryThreshold || 2600}</Text>
                  </View>
                  <View style={styles.thresholdBox}>
                    <Text style={styles.thresholdLabel}>Suggested Threshold</Text>
                    <Text style={[styles.thresholdValue, { color: '#00796B' }]}>{device.insights.suggestedDryThreshold || 2600}</Text>
                  </View>
                </View>
                {device.insights.suggestedDryThreshold && device.insights.suggestedDryThreshold !== device.insights.currentDryThreshold && (
                  <TouchableOpacity
                    style={styles.approveButton}
                    onPress={() => Alert.alert(
                      'Apply suggested threshold?',
                      `Use ${device.insights.suggestedDryThreshold} as the dry threshold? This changes when automatic irrigation starts.`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Approve', style: 'destructive', onPress: () => applySuggestedThreshold(device.insights.suggestedDryThreshold) },
                      ],
                    )}
                  >
                    <Text style={styles.approveButtonText}>Farmer Approval: Apply Threshold</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Notification Settings */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Alert Settings</Text>
              <ControlRow
                title="Irrigation Alerts"
                detail="Receive in-app alerts for dry soil and pump activity"
                value={notificationsEnabled}
                disabled={false}
                onChange={toggleNotifications}
              />
            </View>
          </View>
        ) : (
          /* ================= HISTORY & AI TAB ================= */
          <View style={{ gap: 16 }}>
            {/* Smart Summary Box */}
            <View style={[styles.card, styles.summaryCard]}>
              <Text style={styles.summaryTitle}>💡 Smart Summary (Last 24h)</Text>
              <Text style={styles.summaryText}>{smartSummary}</Text>
            </View>

            {/* 24-Hour Live Moisture Chart Visualizer */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Moisture History (24h)</Text>
              <Text style={styles.helper}>Green zone = Healthy moisture | Red zone = Dry soil</Text>
              
              <HistoryChart history={historyData} />

              {/* Farmer Language Annotations */}
              <View style={styles.annotationContainer}>
                <View style={styles.annotationItem}>
                  <View style={[styles.dot, { backgroundColor: '#2E7D32' }]} />
                  <Text style={styles.annotationText}>Moisture recovering</Text>
                </View>
                <View style={styles.annotationItem}>
                  <View style={[styles.dot, { backgroundColor: '#C62828' }]} />
                  <Text style={styles.annotationText}>Getting drier</Text>
                </View>
                <View style={styles.annotationItem}>
                  <View style={[styles.dot, { backgroundColor: '#1565C0' }]} />
                  <Text style={styles.annotationText}>Pump ran here</Text>
                </View>
              </View>
            </View>

            {/* History Events Timeline List */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Activity Log</Text>
              {historyData.length === 0 ? (
                <Text style={styles.emptyText}>No activity records logged yet.</Text>
              ) : (
                historyData.slice(0, 15).map((item) => (
                  <View key={item.id} style={styles.historyRow}>
                    <View style={styles.historyLeft}>
                      <Text style={styles.historyEventText}>{formatEventName(item.event, item.status, item.pumpState)}</Text>
                      <Text style={styles.historyTime}>{formatTimestamp(item.timestamp)}</Text>
                    </View>
                    <View style={styles.historyRight}>
                      <Text style={styles.historyMoisture}>ADC: {item.moisture ?? '—'}</Text>
                      <Text style={[styles.historyBadge, { color: item.status === 'DRY' ? '#C62828' : '#2E7D32' }]}>{item.status || '—'}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= HELPER COMPONENTS ================= */

function HistoryChart({ history }) {
  // Render a responsive bar/scatter timeline
  const points = useMemo(() => {
    if (!history || history.length === 0) return [];
    return history.slice(0, 14).reverse();
  }, [history]);

  if (points.length === 0) {
    return (
      <View style={styles.chartPlaceholder}>
        <Text style={styles.chartPlaceholderText}>Waiting for periodic samples from ESP32…</Text>
      </View>
    );
  }

  return (
    <View style={styles.chartBox}>
      {/* Background Zones */}
      <View style={styles.zoneWet} />
      <View style={styles.zoneDry} />
      
      <View style={styles.barsContainer}>
        {points.map((p, idx) => {
          const val = typeof p.moisture === 'number' ? p.moisture : 2000;
          // Scale 0..4095 to 0..100% height
          const heightPercent = Math.min(100, Math.max(10, Math.round((val / 4095) * 100)));
          const isDry = val >= 2600;
          const isPump = p.event === 'PUMP_STATE_CHANGED' || p.pumpState === 'ON';

          return (
            <View key={idx} style={styles.barColumn}>
              {isPump && <Text style={styles.pumpIcon}>💧</Text>}
              <View
                style={[
                  styles.chartBar,
                  {
                    height: `${heightPercent}%`,
                    backgroundColor: isPump ? '#1565C0' : isDry ? '#C62828' : '#2E7D32',
                  },
                ]}
              />
              <Text style={styles.barLabel}>{formatTimeShort(p.timestamp)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ConnectionBanner({ connected }) {
  const label = connected === null ? 'Connecting to Firebase…' : connected ? 'Live Real-time Connection' : 'Offline — check internet connection';
  const color = connected === null ? '#EF6C00' : connected ? '#2E7D32' : '#C62828';
  return <Text style={[styles.connection, { backgroundColor: color }]}>{label}</Text>;
}

function StatusBadge({ label, value, color }) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={styles.badgeLabel}>{label}</Text>
      <Text style={styles.badgeValue}>{value}</Text>
    </View>
  );
}

function ControlRow({ title, detail, value, disabled, onChange }) {
  return (
    <View style={styles.controlRow}>
      <View style={styles.controlText}>
        <Text style={styles.controlTitle}>{title}</Text>
        <Text style={styles.controlDetail}>{detail}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: '#B0BEC5', true: '#80CBC4' }}
        thumbColor={value ? '#00796B' : '#ECEFF1'}
      />
    </View>
  );
}

async function triggerLocalNotification(title, body) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'irrigation-alerts' } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.log('Notification error:', e);
  }
}

function pumpColor(state) {
  if (state === 'ON') return '#1565C0';
  if (state === 'SETTLING') return '#EF6C00';
  return '#546E7A';
}

function formatUpdated(timestamp, now) {
  if (typeof timestamp !== 'number') return 'Waiting for the ESP32 to send data';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

function formatTimestamp(ts) {
  if (!ts) return 'Just now';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatEventName(event, status, pumpState) {
  if (event === 'PUMP_STATE_CHANGED') return `Pump turned ${pumpState || 'ON'}`;
  if (event === 'SOIL_STATUS_CHANGED') return `Soil became ${status || 'CHANGED'}`;
  return 'Periodic Sample';
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#004D40' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  appName: { color: '#FFFFFF', fontSize: 32, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#B2DFDB', fontSize: 12, fontWeight: '700', letterSpacing: 2, textAlign: 'center', marginBottom: 12 },
  tabContainer: { flexDirection: 'row', backgroundColor: '#00382E', borderRadius: 12, padding: 4 },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  activeTabButton: { backgroundColor: '#00796B' },
  tabText: { color: '#B2DFDB', fontSize: 14, fontWeight: '600' },
  activeTabText: { color: '#FFFFFF', fontWeight: '800' },
  screen: { padding: 16, paddingBottom: 36, gap: 16 },
  connection: { borderRadius: 10, color: '#FFFFFF', fontSize: 14, fontWeight: '700', overflow: 'hidden', padding: 10, textAlign: 'center' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 18 },
  cardTitle: { color: '#1E293B', fontSize: 20, fontWeight: '700' },
  moistureRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 },
  moistureValue: { color: '#004D40', fontSize: 48, fontWeight: '800' },
  moistureBadgeContainer: { alignItems: 'flex-end' },
  moisturePercentText: { color: '#00796B', fontSize: 28, fontWeight: '800' },
  moisturePercentLabel: { color: '#64748B', fontSize: 12, fontWeight: '600' },
  helper: { color: '#64748B', fontSize: 13, marginTop: 4 },
  gaugeTrack: { backgroundColor: '#E2E8F0', borderRadius: 8, height: 14, marginTop: 14, overflow: 'hidden' },
  gaugeFill: { backgroundColor: '#00796B', height: '100%' },
  updated: { color: '#64748B', fontSize: 13, marginTop: 12 },
  badgeRow: { flexDirection: 'row', gap: 12 },
  badge: { borderRadius: 14, flex: 1, padding: 16 },
  badgeLabel: { color: '#E2E8F0', fontSize: 13, fontWeight: '600' },
  badgeValue: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', marginTop: 4 },
  controlRow: { alignItems: 'center', borderBottomColor: '#F1F5F9', borderBottomWidth: 1, flexDirection: 'row', paddingVertical: 14 },
  controlText: { flex: 1, paddingRight: 12 },
  controlTitle: { color: '#1E293B', fontSize: 17, fontWeight: '700' },
  controlDetail: { color: '#64748B', fontSize: 13, marginTop: 2 },
  automaticNote: { color: '#00796B', fontSize: 15, fontWeight: '600', paddingTop: 14 },
  spinner: { marginTop: 12 },
  error: { color: '#DC2626', fontSize: 14, marginTop: 10 },
  aiCard: { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0', borderWidth: 1 },
  aiHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  aiTag: { color: '#166534', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  aiMode: { color: '#15803D', fontSize: 11, fontWeight: '700' },
  aiBodyText: { color: '#334155', fontSize: 14, marginTop: 8, lineHeight: 20 },
  boldText: { fontWeight: '700', color: '#0F172A' },
  thresholdRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  thresholdBox: { flex: 1, backgroundColor: '#FFFFFF', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#DCFCE7' },
  thresholdLabel: { color: '#64748B', fontSize: 11, fontWeight: '600' },
  thresholdValue: { color: '#1E293B', fontSize: 20, fontWeight: '800', marginTop: 2 },
  approveButton: { backgroundColor: '#00796B', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  approveButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  summaryCard: { backgroundColor: '#F0F9FF', borderColor: '#BAE6FD', borderWidth: 1 },
  summaryTitle: { color: '#0369A1', fontSize: 17, fontWeight: '800', marginBottom: 6 },
  summaryText: { color: '#0C4A6E', fontSize: 14, lineHeight: 20 },
  annotationContainer: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 14 },
  annotationItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  annotationText: { color: '#475569', fontSize: 12, fontWeight: '600' },
  emptyText: { color: '#94A3B8', fontSize: 14, fontStyle: 'italic', marginTop: 8 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  historyLeft: { flex: 1 },
  historyEventText: { color: '#1E293B', fontSize: 15, fontWeight: '700' },
  historyTime: { color: '#64748B', fontSize: 12, marginTop: 2 },
  historyRight: { alignItems: 'flex-end' },
  historyMoisture: { color: '#0F172A', fontSize: 14, fontWeight: '700' },
  historyBadge: { fontSize: 12, fontWeight: '800', marginTop: 2 },
  chartBox: { height: 160, marginTop: 14, justifyContent: 'flex-end', position: 'relative' },
  zoneWet: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', backgroundColor: '#F0FDF4', borderRadius: 8 },
  zoneDry: { position: 'absolute', top: 0, left: 0, right: 0, height: '40%', backgroundColor: '#FEF2F2', borderRadius: 8 },
  barsContainer: { flexDirection: 'row', height: '100%', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 6 },
  barColumn: { alignItems: 'center', flex: 1 },
  chartBar: { width: 10, borderRadius: 4 },
  pumpIcon: { fontSize: 10, marginBottom: 2 },
  barLabel: { fontSize: 9, color: '#64748B', marginTop: 4 },
  chartPlaceholder: { height: 120, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC', borderRadius: 8, marginTop: 14 },
  chartPlaceholderText: { color: '#94A3B8', fontSize: 13 },
});
