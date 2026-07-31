// Firebase web configuration for the AquaSense Expo app.
// Paste the values from Firebase Console > Project settings > Your apps > AquaSense.
// These values identify the Firebase project. Do NOT put the ESP32 database secret here.

import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyDr1KcIwidx0w5ZnvcKbEi39DjCAu-2ngQ',
  authDomain: 'aquasense-grp25.firebaseapp.com',
  databaseURL: 'https://aquasense-grp25-default-rtdb.firebaseio.com',
  projectId: 'aquasense-grp25',
  storageBucket: 'aquasense-grp25.firebasestorage.app',
  messagingSenderId: '1054571323116',
  appId: '1:1054571323116:web:ade1c80d9d72c034cc4fc9',
};

// Expo Fast Refresh can evaluate modules more than once. Reuse the existing app
// so Firebase is initialized only once.
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const database = getDatabase(app);
