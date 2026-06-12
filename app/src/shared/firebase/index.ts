import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyAdlo10LKYEX-c9ittPajqQczf67RHFrgg',
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'enterprise-ai-demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'enterprise-ai-demo',
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ??
    'enterprise-ai-demo.firebasestorage.app',
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '346824017066',
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ?? '1:346824017066:web:d3818133c2985d44fa3cd3',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? 'G-YDX9Q896CR',
}

export const firebaseApp: FirebaseApp = initializeApp(firebaseConfig)

let analyticsInstance: Analytics | null = null

export async function initFirebaseAnalytics(): Promise<Analytics | null> {
  if (analyticsInstance) return analyticsInstance
  if (typeof window === 'undefined') return null
  if (!(await isSupported())) return null

  analyticsInstance = getAnalytics(firebaseApp)
  return analyticsInstance
}

export { firebaseConfig }
