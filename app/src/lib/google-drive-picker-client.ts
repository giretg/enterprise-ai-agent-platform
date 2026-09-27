type PickerDoc = { id: string; name: string; mimeType: string }

type PickerApi = {
  Action: { PICKED: string; CANCEL: string }
  DocsView: new () => {
    setIncludeFolders: (include: boolean) => unknown
    setSelectFolderEnabled: (enabled: boolean) => unknown
  }
  PickerBuilder: new () => {
    setAppId: (appId: string) => unknown
    setOAuthToken: (token: string) => unknown
    setDeveloperKey: (key: string) => unknown
    setOrigin: (origin: string) => unknown
    enableFeature: (feature: string) => unknown
    addView: (view: unknown) => unknown
    setCallback: (cb: (data: { action: string; docs?: PickerDoc[] }) => void) => unknown
    build: () => { setVisible: (visible: boolean) => void }
  }
  Feature: { SUPPORT_DRIVES: string }
}

function pickerApi(): PickerApi | undefined {
  return (window as Window & { google?: { picker: PickerApi } }).google?.picker
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.body.appendChild(script)
  })
}

export async function ensureGooglePickerLoaded(): Promise<void> {
  await loadScript('https://apis.google.com/js/api.js')
  await new Promise<void>((resolve, reject) => {
    const gapi = (window as Window & { gapi?: { load: (api: string, cb: () => void) => void } }).gapi
    if (!gapi) {
      reject(new Error('Google API script failed to initialize'))
      return
    }
    gapi.load('picker', () => resolve())
  })
}

export async function openGoogleDriveFolderPicker(
  session: { accessToken: string; apiKey: string; appId: string; origin: string },
  onFolder: (folder: { id: string; name: string }) => void,
): Promise<void> {
  const api = pickerApi()
  if (!api) throw new Error('Google Picker API missing')

  const docsView = new api.DocsView()
  docsView.setIncludeFolders(true)
  docsView.setSelectFolderEnabled(true)

  const picker = new api.PickerBuilder()
  picker.setAppId(session.appId)
  picker.setOAuthToken(session.accessToken)
  picker.setDeveloperKey(session.apiKey)
  picker.setOrigin(session.origin)
  picker.enableFeature(api.Feature.SUPPORT_DRIVES)
  picker.addView(docsView)
  picker.setCallback((data: { action: string; docs?: PickerDoc[] }) => {
    if (data.action !== api.Action.PICKED || !data.docs?.length) return
    const doc = data.docs.find((d) => d.mimeType === 'application/vnd.google-apps.folder') ?? data.docs[0]
    onFolder({ id: doc.id, name: doc.name })
  })
  picker.build().setVisible(true)
}
